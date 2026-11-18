#!/usr/bin/env python3
"""Test a local Compose stack with Node Playwright and an H.264/AAC-capable Chromium.

Set PLAYWRIGHT_MODULE and CHROMIUM_PATH to use installations outside the checkout.
API_PORT selects the published localhost port (default 18321).
"""
import base64
import json
import runpy
import subprocess
import sys
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, urlopen

media = runpy.run_path(str(Path(__file__).with_name("media-smoke.py")))
api, compose, require = (media[key] for key in ("api", "compose", "require"))
origin = media["BASE"].removesuffix("/api/v1")


def login(role):
    principal = json.loads(compose("run", "--rm", "--no-deps", "-T", "migrate",
                                   "node", "dist/provision.js", role))
    token = api("POST", "/auth/token", 201, principal["credential"])["token"]
    return principal["id"], token


def sql(statement):
    compose("exec", "-T", "db", "psql", "-U", "postgres", "-d", "openshield",
            "-v", "ON_ERROR_STOP=1", "-c", statement)


def http(method, path, status, token=None, payload=None):
    url = urljoin(origin, path)
    require(urlsplit(url).netloc == urlsplit(origin).netloc, "Unexpected media origin")
    headers = {"Authorization": "Bearer " + token} if token else {}
    body = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(payload).encode()
    try:
        response = urlopen(Request(url, body, headers, method=method), timeout=15)
    except HTTPError as exc:
        response = exc
    with response:
        require(response.status == status,
                f"{method} {urlsplit(path).path} returned {response.status}, expected {status}")
        return response.read()


def main():
    _, owner = login("publisher")
    viewer_id, viewer = login("viewer")
    try:
        content = uuid.UUID(api("POST", "/content", 201, owner, b'{"title":"Playback QA"}',
                                "application/json")["id"])
        fixture = compose("exec", "-T", "worker", "ffmpeg", "-v", "error", "-nostdin",
                          "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=12",
                          "-f", "lavfi", "-i", "sine=frequency=800:sample_rate=44100",
                          "-t", "8", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p",
                          "-c:a", "aac", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1")
        job_id = api("POST", f"/content/{content}/assets", 202, owner,
                     fixture, "video/mp4")["jobId"]
        media["wait_job"](job_id, owner, success=True)
        package = media["output_files"](job_id)
        kid = media["inspect_package"](package)
        mpd = ET.fromstring(package["manifest.mpd"])
        adaptations = mpd.findall(".//{*}AdaptationSet")
        types = set()
        for adaptation in adaptations:
            for rep in adaptation.findall("{*}Representation"):
                ref = rep.findtext("{*}BaseURL")
                segment = rep.find("{*}SegmentBase/{*}Initialization")
                end = int(segment.attrib["range"].split("-")[1]) + 1
                data = package[ref]
                track = adaptation.get("contentType") or rep.get("mimeType", "").split("/")[0]
                types.add(track)
                require((b"encv" if track == "video" else b"enca") in data[:end],
                        "Missing protected sample entry")
                require(b"cbcs" in media["box_payload"](data[:end], b"schm"), "Expected CBCS")
                fragment = media["box_payload"](data[end:], b"moof")
                require(int.from_bytes(media["box_payload"](fragment, b"senc")[4:8], "big") > 0,
                        "First fragment has no encrypted samples")
        require(types == {"audio", "video"}, "Expected encrypted audio and video")

        path = f"/jobs/{job_id}/playback"
        api("POST", path, 401)
        api("POST", path, 404, viewer)
        sql(f"INSERT INTO content_entitlements(user_id,content_id) VALUES('{uuid.UUID(viewer_id)}','{content}')")
        session = api("POST", path, 201, viewer)
        manifest, license_url = session["manifestUrl"], session["licenseUrl"]
        bearer = session["token"]
        def challenge(key):
            return {"kids": [base64.urlsafe_b64encode(key.bytes).decode().rstrip("=")], "type": "temporary"}

        http("GET", manifest, 401)
        http("POST", license_url, 401, payload=challenge(kid))
        http("GET", manifest, 200, bearer)
        http("POST", license_url, 403, bearer, challenge(uuid.uuid4()))
        reply = json.loads(http("POST", license_url, 200, bearer, challenge(kid)))
        require(len(reply["keys"]) == 1 and reply["keys"][0]["kid"] == challenge(kid)["kids"][0],
                "License returned the wrong KID")
        subprocess.run(["node", str(Path(__file__).with_name("playback-browser.cjs"))],
                       input=json.dumps(dict(origin=origin, jobId=job_id, token=viewer)).encode(),
                       check=True)
        sid = uuid.UUID(session["sessionId"])
        sql(f"UPDATE playback_sessions SET expires_at=now() WHERE id='{sid}'")
        http("GET", manifest, 401, bearer)
        http("POST", license_url, 401, bearer, challenge(kid))
        revoked = api("POST", path, 201, viewer)
        api("DELETE", f"/playback/{revoked['sessionId']}", 204, viewer)
        http("GET", revoked["manifestUrl"], 401, revoked["token"])
        http("POST", revoked["licenseUrl"], 401, revoked["token"], challenge(kid))
        active = api("POST", path, 201, viewer)
        sql(f"UPDATE content_entitlements SET ends_at=now() WHERE user_id='{uuid.UUID(viewer_id)}' AND content_id='{content}'")
        http("GET", active["manifestUrl"], 401, active["token"])
        http("POST", active["licenseUrl"], 401, active["token"], challenge(kid))
        active = api("POST", path, 201, owner)
        sql(f"UPDATE encryption_keys SET revoked_at=now() WHERE content_id='{content}'")
        http("GET", active["manifestUrl"], 401, active["token"])
        http("POST", active["licenseUrl"], 401, active["token"], challenge(kid))
        capabilities = api("GET", "/license/capabilities", 200)
        require(capabilities["clearkey"] and not capabilities["widevine"] and not capabilities["fairplay"],
                "Unexpected enabled license providers")
    finally:
        for token in (viewer, owner):
            api("DELETE", "/auth/session", 204, token)
    print("Passed encrypted audio/video playback, entitlement, missing auth, KID, expiry, session and key revocation")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, subprocess.CalledProcessError) as exc:
        sys.exit(f"Playback smoke failed: {exc}")
