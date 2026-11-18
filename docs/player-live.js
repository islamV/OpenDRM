/* Browser adapter for the same-origin OpenShield service. */
(() => {
  'use strict';
  let library, active, sequence=0;
  function issue(code){return Object.assign(new Error(code),{code})}
  function statusCode(status){return ({401:'unauthorized',403:'forbidden',404:'unavailable',409:'pending',429:'rate_limited',503:'unavailable'})[status] || 'error'}
  async function json(url,options) {
    const response=await fetch(url,{...options,redirect:'error',cache:'no-store',credentials:'omit'});
    if(!response.ok)throw issue(statusCode(response.status));
    return response.json();
  }
  function loadLibrary(){
    if(!library)library=new Promise((resolve,reject)=>{
      const script=document.createElement('script');script.src='/player/shaka.js';
      script.onload=()=>{window.shaka.polyfill.installAll();resolve(window.shaka)};
      script.onerror=()=>{library=undefined;reject(issue('unavailable'))};document.head.append(script);
    });
    return library;
  }
  async function dispose(s){
    if(!s)return;
    clearTimeout(s.expiry);clearInterval(s.poll);
    await Promise.allSettled([s.player?.destroy(),fetch(s.base,{method:'DELETE',redirect:'error',headers:s.headers,keepalive:true})]);
  }
  async function stop(){sequence++; const old=active;active=null;await dispose(old)}
  async function start(video,create,onState=()=>{}){
    await stop();const revision=sequence;
    if(!window.isSecureContext || !navigator.requestMediaKeySystemAccess)throw issue('unsupported');
    const shaka=await loadLibrary();
    if(!shaka.Player.isBrowserSupported())throw issue('unsupported');
    const grant=await create();
    const sessionBase='/api/v1/playback/'+grant.sessionId;
    const manifest=sessionBase+'/media/manifest.mpd',license=sessionBase+'/license';
    if(!/^[0-9a-f-]{36}$/.test(grant.sessionId)||grant.manifestUrl!==manifest||grant.licenseUrl!==license)throw issue('error');
    const s={base:sessionBase,headers:{Authorization:'Bearer '+grant.token},player:new shaka.Player()};
    if(revision!==sequence){await dispose(s);throw issue('error')}
    active=s;
    const fail=async code=>{
      if(active!==s)return;
      video.pause();await stop();onState(code);
    };
    try {
      await s.player.attach(video);
      const keySystem='org.w3.clearkey';
      s.player.configure({drm:{servers:{[keySystem]:location.origin+license},preferredKeySystems:[keySystem]},
        manifest:{dash:{keySystemsByURI:{'urn:uuid:1077efec-c0b2-4d02-ace3-3c1e52e2fb4b':keySystem}}}});
      s.player.getNetworkingEngine().registerRequestFilter((_type,request)=>{
        if(!request.uris.length||request.uris.some(uri=>{
          const url=new URL(uri,location.href);
          return url.origin!==location.origin || !(url.pathname===license || url.pathname.startsWith(sessionBase+'/media/'));
        }))throw issue('forbidden');
        Object.assign(request.headers,s.headers);
      });
      s.player.addEventListener('error',e=>{
        if(e.detail.severity===shaka.util.Error.Severity.CRITICAL)void fail('error');
      });
      await s.player.load(location.origin+manifest,undefined,'application/dash+xml');
      if(active!==s)throw issue('error');
      s.expiry=setTimeout(()=>void fail('expired'),Math.max(0,grant.expiresIn)*1000);
      s.poll=setInterval(async()=>{
        try{const check=await fetch(manifest,{method:'HEAD',headers:s.headers,cache:'no-store',redirect:'error'});
          if(!check.ok)await fail(check.status===401?'expired':statusCode(check.status));
        }catch{await fail('unavailable')}
      },10000);
      onState('ready');
      try {await video.play()}catch(e){if(e.name!=='NotAllowedError')throw e}
    }catch(e){if(active===s)await stop();throw issue(e.code===6001?'unsupported':'error')}
  }
  window.OpenShieldLive={
    capabilities:()=>json('/api/v1/license/capabilities'),
    load:(video,id,token,state)=>start(video,()=>json('/api/v1/jobs/'+encodeURIComponent(id)+'/playback',
      {method:'POST',headers:{Authorization:'Bearer '+token}}),state),
    loadDemo:(video,state)=>start(video,()=>json('/player/demo',{method:'POST'}),state),
    stop
  };
  addEventListener('pagehide',()=>void stop());
})();
