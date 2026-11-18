#!/usr/bin/env python3
"""Run against the active local Compose stack: python3 tests/media-smoke.py."""

import base64
import io
import json
import os
import posixpath
import re
import subprocess
import sys
import tarfile
import time
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
BASE = f"http://127.0.0.1:{int(os.environ.get('API_PORT', 18321))}/api/v1"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def compose(*args):
    result = subprocess.run(["docker", "compose", *args], cwd=ROOT, capture_output=True)
    # Provisioning responses can contain credentials. Never print captured streams.
    require(result.returncode == 0, f"Compose command failed ({args[0]})")
    return result.stdout


def api(method, path, status, token=None, body=None, media_type=None):
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if media_type:
        headers["Content-Type"] = media_type
    req = Request(BASE + path, method=method, data=body, headers=headers)
    try:
        response = urlopen(req, timeout=20)
    except HTTPError as exc:
        response = exc
    with response:
        require(response.status == status,
                f"{method} {path} returned {response.status}, expected {status}")
        payload = response.read()
    return json.loads(payload) if payload else {}


def wait_job(job_id, token, success):
    deadline = time.monotonic() + 150
    while time.monotonic() < deadline:
        job = api("GET", f"/jobs/{job_id}", 200, token)
        require(job["id"] == job_id, "Status returned a different job")
        if job["state"] in {"completed", "failed"}:
            if success:
                require(job["state"] != "failed" and job.get("outputs"),
                        "Packaging failed or returned no outputs")
            else:
                require(job["state"] == "failed" and job.get("errorCode"),
                        "Invalid media did not produce a failure code")
            return
        time.sleep(2)
    raise RuntimeError("Worker did not reach a terminal state before timeout")


def output_files(job_id):
    uuid.UUID(job_id)
    archive = compose("exec", "-T", "worker", "tar", "-C",
                      f"/media/output/{job_id}", "-cf", "-", ".")
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tar:
        return {posixpath.normpath(entry.name): tar.extractfile(entry).read()
                for entry in tar if entry.isfile()}


def box_payload(data, kind):
    for match in re.finditer(kind, data):
        pos = match.start()
        if pos >= 4:
            size = int.from_bytes(data[pos-4:pos], "big")
            if size >= 8 and pos - 4 + size <= len(data):
                return data[pos+4:pos-4+size]
    raise RuntimeError(f"Missing valid {kind.decode()} box")


def inspect_package(files):
    require("master.m3u8" in files and "manifest.mpd" in files, "Missing manifest")
    require(not any(name.lower().endswith((".key", ".pem")) for name in files),
            "Unexpected key file in published package")
    mpd = ET.fromstring(files["manifest.mpd"])
    kids = {uuid.UUID(value) for node in mpd.iter() for attr, value in node.attrib.items()
            if attr.split("}")[-1] == "default_KID"}
    require(len(kids) == 1, "Expected one public DASH default_KID")
    kid = kids.pop()
    pssh = mpd.findall(".//{*}pssh")
    require(pssh, "Missing DASH PSSH")
    for entry in pssh:
        payload = box_payload(base64.b64decode(entry.text.strip(), validate=True), b"pssh")
        require(kid.bytes in payload, "DASH PSSH has no matching KID")
    representations = mpd.findall(".//{*}Representation")
    require(representations, "DASH has no representations")
    for rep in representations:
        ref = rep.findtext("{*}BaseURL")
        require(ref in files, "DASH references a missing media file")
        segment_base = rep.find("{*}SegmentBase")
        require(segment_base is not None, "Missing DASH segment index")
        init = segment_base.find("{*}Initialization")
        require(init is not None, "Missing DASH initialization range")
        start, end = map(int, init.attrib["range"].split("-"))
        require(0 <= start <= end < len(files[ref]), "Invalid DASH initialization range")
        require(kid.bytes in box_payload(files[ref][start:end+1], b"tenc"),
                "DASH init segment has a different KID")
        box_payload(files[ref][end+1:], b"senc")

    master = files["master.m3u8"].decode()
    variants = [line.strip() for line in master.splitlines() if line and not line.startswith("#")]
    variants += re.findall(r'^#EXT-X-MEDIA:.*?URI="([^"]+)"', master, re.M)
    require(variants, "HLS master has no variant references")
    for variant in variants:
        require(variant in files, "HLS master references a missing playlist")
        playlist = files[variant].decode()
        tags = playlist.splitlines()
        key_tags = [line for line in tags if line.startswith("#EXT-X-KEY:")]
        require(key_tags, "HLS playlist has no encryption tag")
        for line in key_tags:
            require("METHOD=SAMPLE-AES" in line, "Expected HLS sample encryption")
            key_uri = re.search(r'URI="([^"]+)"', line)
            require(key_uri, "HLS encryption tag has no key reference")
            uri = key_uri.group(1)
            require(uri.lower() == f"urn:uuid:{kid}",
                    "HLS key reference does not match the public DASH KID")
        maps = [line for line in tags if line.startswith("#EXT-X-MAP:")]
        require(len(maps) == 1, "Expected a single HLS initialization range")
        init_uri = re.search(r'URI="([^"]+)"', maps[0])
        init_range = re.search(r'BYTERANGE="(\d+)@(\d+)"', maps[0])
        require(init_uri and init_range, "Invalid HLS initialization reference")
        base = posixpath.dirname(variant)
        init_file = posixpath.normpath(posixpath.join(base, init_uri.group(1)))
        require(init_file in files, "Missing HLS initialization file")
        length, offset = map(int, init_range.groups())
        require(kid.bytes in box_payload(files[init_file][offset:offset+length], b"tenc"),
                "HLS initialization KID mismatch")
        count = 0
        last_end = 0
        for i, tag in enumerate(tags):
            if not tag.startswith("#EXT-X-BYTERANGE:"):
                continue
            count += 1
            length_text, _, offset_text = tag.split(":", 1)[1].partition("@")
            offset = int(offset_text) if offset_text else last_end
            last_end = offset + int(length_text)
            require(i + 1 < len(tags), "HLS lacks a segment URI")
            name = posixpath.normpath(posixpath.join(base, tags[i+1]))
            require(name in files and 0 <= offset < last_end <= len(files[name]),
                    "HLS references missing segment bytes")
            box_payload(files[name][offset:last_end], b"senc")
        require(count > 0, "HLS variant has no segments")
    return kid


def fixture():
    return compose("exec", "-T", "worker", "ffmpeg", "-v", "error", "-nostdin",
                   "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=12",
                   "-f", "lavfi", "-i", "sine=frequency=800:sample_rate=44100",
                   "-t", "2", "-c:a", "aac", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p",
                   "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1")


def main():
    credential = json.loads(compose("run", "--rm", "--no-deps", "-T", "migrate",
                                    "node", "dist/provision.js", "publisher"))["credential"]
    token = api("POST", "/auth/token", 201, credential)["token"]
    try:
        content = api("POST", "/content", 201, token, b'{"title":"Media smoke fixture"}',
                      "application/json")["id"]
        path = f"/content/{content}/assets"
        clip = fixture()
        api("POST", path, 401, body=clip, media_type="video/mp4")
        upload = api("POST", path, 202, token, clip, "video/mp4")
        job_id, asset_id = upload["jobId"], upload["assetId"]
        api("GET", f"/jobs/{job_id}", 401)
        rotate_path = f"/assets/{asset_id}/rotate"
        api("POST", rotate_path, 401)
        wait_job(job_id, token, success=True)
        first = output_files(job_id)
        kid = inspect_package(first)
        rotated = api("POST", rotate_path, 202, token)["jobId"]
        require(rotated != job_id, "Rotation did not create a new packaging job")
        wait_job(rotated, token, success=True)
        require(inspect_package(output_files(rotated)) != kid, "Rotation reused the KID")
        require(output_files(job_id) == first, "Rotation changed the original package")
        invalid = api("POST", path, 202, token, b"This is not a media file.", "video/mp4")
        wait_job(invalid["jobId"], token, success=False)
    finally:
        api("DELETE", "/auth/session", 204, token)
    print("Passed media upload, encrypted DASH/HLS, rotation, invalid media and anonymous access")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, ET.ParseError, tarfile.TarError) as exc:
        sys.exit(f"Media smoke test failed: {exc}")
