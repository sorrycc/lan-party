/* Loaded Dice - a one-button dice duel. Game module for the LAN party shell; the contract is documented at the top of games/kart/index.js.

   One button: a cursor sweeps across a rig bar, a press picks the slot under it (GOOD, or PERFECT near the middle) and rigs the roll of
   a die, which is a real convex polyhedron drawn orthographically on a 2D canvas (flat shaded, ink stroked; no WebGL, no assets).
   Everything is drawn in a 1280x720 design space fitted into the stage inside the safe-area insets; on a phone-sized view (`compact`)
   the HUD panels, the bar and the cards are drawn larger inside that space, because a letterboxed 9px label is not readable.

   Alone (PLAY SOLO, or a room of one) it is a run: Sir Rollo against a ladder of CPU fighters (foes.js), perks on level up, the best
   score kept per browser. With two players it is a duel between them: both bars sweep at once, each player sees the other's slots but
   not the pick, and the dice are thrown when both have pressed. Both are the same rules (rules.js); this file turns a round's outcome
   into words, poses, particles and sounds. Every word comes from strings.js: Chinese by default, English from the ☰ menu (or L).

   Netcode (two players): host-authoritative and turn-shaped, so nothing is streamed. The host sends `round` (hearts, speeds, fever, and to
   each player their own bar whole and the other's only as the slots they are to see), every machine runs its own sweep on its own clock,
   so the press is graded where the finger is and the link's latency is not in it, and answers with `pick` (the sweep's progress `u`: a
   bar may move, and bar.js makes all of it a function of `u`); the host tells the room a side has `locked`, rolls for both when the two picks are in
   (or the sweep's deadline has passed: a plain roll for whoever is missing), and sends `result`: the rolls, what each side shouts and
   takes, and the standings. Each screen puts its own player on the left. Every message carries the round's seed as `m`, so a
   straggler from the last match is dropped after PLAY AGAIN. */
import { AVATARS } from '../../core/avatars.js';
import { esc, hex, loadStylesheet } from '../../core/ui.js';
import { createInput } from '../../core/input.js';
import { createLoop } from '../../core/loop.js';
import { createTicker } from '../../core/ticker.js';
import { isCoarse } from '../../core/touch.js';
import { makeRng } from '../../core/math.js';
import { cleanPick, cursorAt, fogged, gradeAt, isDouble, mkBar, shownSlots, slotsAt, spanOf } from './bar.js';
import { DIE_STEPS, FEVER_MAX, SWEEP_T, TO_HIT, carve, dealFaces, dieForRound, featsFor, freeFaces, genSlots, isHot, mkDuelist, mkMods, playRound, speedOf } from './rules.js';
import { foeTurn, mkFoe, mkHero, slotHint, stealSlot } from './foes.js';
import { dealPerks } from './perks.js';
import { LANGS, mkT } from './strings.js';

const HTML = `
<canvas class="cv"></canvas>
<div class="sa"></div>
<div class="menu-btn" data-menu>☰</div>
<div class="overlay" data-pause><div class="mcard"><h1 data-t="menu"></h1><div data-pause-btns></div></div></div>
<div class="overlay" data-help><div class="mcard howto"><h1 data-t="howto"></h1><div data-help-body></div><button class="btn primary" data-help-ok data-t="gotIt"></button></div></div>
<div class="overlay" data-result><div class="mcard result"><small data-res-kick></small><h1 data-res-title></h1><div class="rows" data-res-rows></div><div class="btns" data-res-btns></div><p data-res-foot></p></div></div>
<div class="overlay rotate"><div><div class="phone">📱</div><span data-t="rotate"></span><small data-t="rotateSub"></small></div></div>`;

export async function create({ mount, audio, send, hooks }) {
  const unloadCss = await loadStylesheet('/games/dice/dice.css');
  const touch = isCoarse(); // phones and tablets: a tap anywhere is the button, the ☰ menu appears and the keyboard hints go
  const root = document.createElement('div'); root.className = 'dice' + (touch ? ' touch' : ''); root.innerHTML = HTML; mount.appendChild(root);
  const $ = sel => root.querySelector(sel);
  const dom = { menuBtn: $('[data-menu]'), pause: $('[data-pause]'), pauseBtns: $('[data-pause-btns]'), help: $('[data-help]'), helpBody: $('[data-help-body]'), helpOk: $('[data-help-ok]'),
    result: $('[data-result]'), resKick: $('[data-res-kick]'), resTitle: $('[data-res-title]'), resRows: $('[data-res-rows]'), resBtns: $('[data-res-btns]'), resFoot: $('[data-res-foot]') };
  const cv = $('canvas.cv'), ctx = cv.getContext('2d');
  const W=1280,H=720,GROUND=590,DIE_GY=560,TAU=Math.PI*2;
  const INK='#25231f',BG='#f3eee3',RED='#d9534a',YEL='#f0cf4f',GRN='#a8c878',SLOT_RED='#e39a88';
  const HUDF='"Avenir Next Condensed","DIN Condensed","Roboto Condensed","Arial Narrow","PingFang SC","Hiragino Sans GB","Noto Sans SC","Microsoft YaHei",system-ui,sans-serif';
  /* the language: Chinese unless this browser was told otherwise. The canvas is redrawn every frame, so only the DOM cards need telling. */
  let lang='zh';try{const l=localStorage.getItem('loadedDiceLang');if(LANGS.includes(l))lang=l}catch(e){}
  let T=mkT(lang);
  function setLang(l){lang=l;T=mkT(l);try{localStorage.setItem('loadedDiceLang',l)}catch(e){}root.classList.toggle('zh',l==='zh');root.querySelectorAll('[data-t]').forEach(el=>el.textContent=T(el.dataset.t))}
  const LS='letterSpacing' in ctx;
  const rnd=(a,b)=>a+Math.random()*(b-a),ri=(a,b)=>Math.floor(rnd(a,b+1)),clamp=(v,a,b)=>v<a?a:v>b?b:v,lerp=(a,b,t)=>a+(b-a)*t;
  const pick=a=>a[Math.floor(Math.random()*a.length)];

  /* ---------- canvas fit ----------
     The view is the stage's own box (watched with a ResizeObserver: an iPad's innerWidth is not a reliable measure the moment a rotation
     or a split-screen resize fires). The 1280x720 design space is fitted inside the safe-area insets (notch, home indicator), read off
     an element the stylesheet pads with them; the paper colour fills the rest. SC / OX / OY are in canvas pixels. */
  let SC=1,OX=0,OY=0,DPR=1,compact=false;
  const saEl=$('.sa'),sa={t:0,r:0,b:0,l:0};
  function measureSafeArea(){const r=saEl.getBoundingClientRect(),R=root.getBoundingClientRect();if(!(r.width>0&&r.height>0))return; // no size while the shell still hides the stage
    sa.t=Math.max(0,r.top-R.top);sa.l=Math.max(0,r.left-R.left);sa.r=Math.max(0,R.right-r.right);sa.b=Math.max(0,R.bottom-r.bottom)}
  function fit(){const w=root.clientWidth||innerWidth,h=root.clientHeight||innerHeight;DPR=Math.min(2,window.devicePixelRatio||1);
    cv.width=Math.round(w*DPR);cv.height=Math.round(h*DPR);measureSafeArea();
    const aw=Math.max(1,w-sa.l-sa.r),ah=Math.max(1,h-sa.t-sa.b),s=Math.min(aw/W,ah/H);
    SC=s*DPR;OX=(sa.l+(aw-W*s)/2)*DPR;OY=(sa.t+(ah-H*s)/2)*DPR;compact=s<.68}
  const ro=typeof ResizeObserver==='function'?new ResizeObserver(fit):null;addEventListener('resize',fit);ro?.observe(root);fit();

  /* ---------- audio (tiny synth on the shell's context, which the shell unlocks and routes past an iPhone's silent switch) ---------- */
  let AC=null,master=null,noiseBuf=null;
  const unsubAudio=audio.whenReady((ac,out)=>{AC=ac;master=ac.createGain();master.gain.value=.9;master.connect(out);
    noiseBuf=ac.createBuffer(1,ac.sampleRate*.5,ac.sampleRate);const d=noiseBuf.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=Math.random()*2-1});
  function tone(f,dur,type='square',vol=.18,slide=0,delay=0){if(!AC||audio.muted||G.auto)return;f*=G.pitch;slide*=G.pitch;const t=AC.currentTime+delay,o=AC.createOscillator(),g=AC.createGain();
    o.type=type;o.frequency.setValueAtTime(f,t);if(slide)o.frequency.exponentialRampToValueAtTime(Math.max(20,f+slide),t+dur);
    g.gain.setValueAtTime(vol,t);g.gain.exponentialRampToValueAtTime(.001,t+dur);o.connect(g);g.connect(master);o.start(t);o.stop(t+dur+.02)}
  function noise(dur,vol=.25,fc=1200,q=.8,delay=0,type='bandpass'){if(!AC||audio.muted||G.auto)return;const t=AC.currentTime+delay,s=AC.createBufferSource(),f=AC.createBiquadFilter(),g=AC.createGain();
    s.buffer=noiseBuf;f.type=type;f.frequency.value=fc;f.Q.value=q;g.gain.setValueAtTime(vol,t);g.gain.exponentialRampToValueAtTime(.001,t+dur);
    s.connect(f);f.connect(g);g.connect(master);s.start(t,Math.random()*.2,dur+.02)}
  const SFX={
    perfect(n=0){const k=2**(Math.min(12,n)/12);tone(880*k,.07,'square',.14);tone(1320*k,.14,'square',.14,0,.06)}, // a streak climbs a semitone a press, up to an octave
    good(){tone(660,.09,'square',.13)},
    miss(){tone(150,.25,'sawtooth',.2,-90);noise(.15,.15,400)},
    plain(){tone(330,.06,'triangle',.12)},
    toss(){noise(.08,.12,2600,2)},
    thud(v=1){tone(95,.16,'sine',.5*v,-55);noise(.09,.28*v,700,.6)},
    rattle(){noise(.04,.16,3000,3)},
    hit(){noise(.14,.4,900,.5,0,'lowpass');tone(130,.16,'sine',.4,-70)},
    crit(){SFX.hit();[660,880,1320,1760].forEach((f,i)=>tone(f,.1,'triangle',.16,0,.04*i))},
    block(){tone(1180,.12,'square',.12);tone(1770,.16,'square',.09);noise(.05,.2,4000,2)},
    dodge(){noise(.2,.2,1800,1.2)},
    heal(){[523,659,784].forEach((f,i)=>tone(f,.16,'sine',.2,0,.07*i))},
    spook(){tone(220,.3,'sawtooth',.14,-120);tone(233,.3,'sawtooth',.1,-120)},
    up(){tone(440,.08,'square',.1);tone(660,.1,'square',.1,0,.07)},
    down(){tone(660,.08,'square',.1);tone(440,.12,'square',.1,0,.07)},
    level(){[523,659,784,1047,1319].forEach((f,i)=>tone(f,.16,'triangle',.18,0,.08*i))},
    pickp(){tone(784,.08,'square',.12);tone(1047,.16,'square',.12,0,.07)},
    tick(){tone(1500,.02,'square',.04)},
    ko(){[400,300,220,150].forEach((f,i)=>tone(f,.14,'square',.14,-40,.09*i));noise(.3,.3,300,.5,.3,'lowpass')},
    dead(){[330,262,196,131,98].forEach((f,i)=>tone(f,.28,'sawtooth',.16,-20,.16*i))},
    clash(){tone(1500,.1,'square',.1);tone(2100,.12,'square',.08);noise(.08,.3,5000,2)},
    jackpot(){[784,988,1175,1568,1976,2349].forEach((f,i)=>tone(f,.12,'square',.13,0,.05*i));noise(.25,.12,6000,3,.3)},
    boom(){noise(.45,.55,180,.4,0,'lowpass');tone(70,.4,'sine',.5,-40);noise(.12,.3,2400,1)},
    venom(){tone(300,.25,'sawtooth',.1,-160);noise(.3,.12,2200,4,.05)},
    carve(){noise(.06,.2,3500,3);tone(1320,.2,'triangle',.14,0,.05);tone(1760,.25,'triangle',.12,0,.12)},
    ink(){noise(.35,.3,500,.7,0,'lowpass');tone(180,.3,'sine',.2,-90)},
    fever(){[392,523,659,784,1047].forEach((f,i)=>tone(f,.2,'sawtooth',.1,0,.06*i))},
  };

  /* ---------- tiny 3D maths ---------- */
  const vsub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]],vadd=(a,b)=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]],vmul=(a,s)=>[a[0]*s,a[1]*s,a[2]*s];
  const vdot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2],vcross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const vlen=a=>Math.hypot(a[0],a[1],a[2]),vnorm=a=>{const l=vlen(a)||1;return[a[0]/l,a[1]/l,a[2]/l]};
  const mapply=(M,v)=>[vdot(M[0],v),vdot(M[1],v),vdot(M[2],v)];
  const mT=M=>[[M[0][0],M[1][0],M[2][0]],[M[0][1],M[1][1],M[2][1]],[M[0][2],M[1][2],M[2][2]]];
  function mmul(A,B){const Bt=mT(B);return A.map(r=>Bt.map(c=>vdot(r,c)))}
  function rodrigues(a,t){const c=Math.cos(t),s=Math.sin(t),C=1-c,[x,y,z]=a;
    return[[c+x*x*C,x*y*C-z*s,x*z*C+y*s],[y*x*C+z*s,c+y*y*C,y*z*C-x*s],[z*x*C-y*s,z*y*C+x*s,c+z*z*C]]}
  function axisAngle(D){const tr=D[0][0]+D[1][1]+D[2][2],ang=Math.acos(clamp((tr-1)/2,-1,1));
    let ax=[D[2][1]-D[1][2],D[0][2]-D[2][0],D[1][0]-D[0][1]];if(vlen(ax)<1e-4)ax=[rnd(-1,1),rnd(-1,1),rnd(-1,1)];return{axis:vnorm(ax),ang}}
  // rotation taking model frame (r,u,n) to view frame (Rt,U,N)
  function frameRot(u,n,U,N){const r=vcross(u,n),Rt=vcross(U,N),M=[[0,0,0],[0,0,0],[0,0,0]];
    for(let i=0;i<3;i++)for(let j=0;j<3;j++)M[i][j]=Rt[i]*r[j]+U[i]*u[j]+N[i]*n[j];return M}

  /* ---------- dice geometry ---------- */
  function dieVerts(n){const p=(1+Math.sqrt(5))/2,v=[];
    if(n===4)return[[1,1,1],[1,-1,-1],[-1,1,-1],[-1,-1,1]];
    if(n===5){for(const z of[-.72,.72])for(let k=0;k<3;k++)v.push([Math.cos(k*TAU/3),Math.sin(k*TAU/3),z]);return v}
    if(n===6){for(const x of[-1,1])for(const y of[-1,1])for(const z of[-1,1])v.push([x,y,z]);return v}
    if(n===8)return[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
    if(n===10){const c36=Math.cos(TAU/10),c=(1-c36)/(1+c36);v.push([0,0,1],[0,0,-1]);for(let k=0;k<10;k++)v.push([Math.cos(k*TAU/10),Math.sin(k*TAU/10),k%2?c:-c]);return v}
    if(n===12){for(const x of[-1,1])for(const y of[-1,1])for(const z of[-1,1])v.push([x,y,z]);
      for(const a of[-1,1])for(const b of[-1,1]){v.push([0,a/p,b*p],[a/p,b*p,0],[a*p,0,b/p])}return v}
    for(const a of[-1,1])for(const b of[-1,1]){v.push([0,a,b*p],[a,b*p,0],[a*p,0,b])}return v; // d20
  }
  function buildDie(n){let V=dieVerts(n);const m=Math.max(...V.map(vlen));V=V.map(v=>vmul(v,1/m));
    const faces=[],seen=new Set(),E=1e-4;
    for(let i=0;i<V.length;i++)for(let j=i+1;j<V.length;j++)for(let k=j+1;k<V.length;k++){
      let nn=vcross(vsub(V[j],V[i]),vsub(V[k],V[i]));if(vlen(nn)<E)continue;nn=vnorm(nn);let d=vdot(nn,V[i]),pos=false,neg=false;
      for(const q of V){const s=vdot(nn,q)-d;if(s>E)pos=true;else if(s<-E)neg=true}
      if(pos&&neg)continue;if(pos){nn=vmul(nn,-1);d=-d}
      const idx=[];V.forEach((q,t)=>{if(Math.abs(vdot(nn,q)-d)<E)idx.push(t)});
      const key=idx.join(',');if(seen.has(key))continue;seen.add(key);
      let c=[0,0,0];idx.forEach(t=>c=vadd(c,V[t]));c=vmul(c,1/idx.length);
      const a=vnorm(vsub(V[idx[0]],c)),b=vcross(nn,a);
      idx.sort((s,t)=>Math.atan2(vdot(vsub(V[s],c),b),vdot(vsub(V[s],c),a))-Math.atan2(vdot(vsub(V[t],c),b),vdot(vsub(V[t],c),a)));
      // inradius + text up direction
      let inr=9;for(let e=0;e<idx.length;e++){const A=V[idx[e]],B=V[idx[(e+1)%idx.length]],ed=vnorm(vsub(B,A)),w=vsub(c,A);inr=Math.min(inr,vlen(vsub(w,vmul(ed,vdot(w,ed)))))}
      const ds=idx.map(t=>vlen(vsub(V[t],c))),mx=Math.max(...ds),mn=Math.min(...ds);let up;
      if(mx-mn>.02)up=vsub(V[idx[ds.indexOf(mx)]],c);else if(idx.length%2)up=vsub(V[idx[0]],c);else up=vsub(vmul(vadd(V[idx[0]],V[idx[1]]),.5),c);
      faces.push({idx,n:nn,c,up:vnorm(up),inr});
    }
    if(faces.length!==n)console.warn('die',n,'has',faces.length,'faces');
    return{n,V,faces}
  }
  const GEO={};DIE_STEPS.forEach(n=>GEO[n]=buildDie(n));
  const DIE_SCALE={4:84,5:70,6:64,8:74,10:72,12:66,20:70};
  const FACE_RGB={vamp:[240,170,165],double:[250,215,110],guard:[175,205,225],venom:[180,215,140],lucky:[200,180,235]};
  const TILT=25*Math.PI/180,GN=[0,Math.cos(TILT),Math.sin(TILT)],GD=[0,-Math.sin(TILT),Math.cos(TILT)];
  const LDIR=vnorm(vadd(vadd(vmul(GN,-1),[.6,0,0]),vmul(GD,.35))),SHADE=vnorm([-.45,.8,.5]);

  const mkDie=x=>({n:4,geo:GEO[4],R:null,x,home:x,jit:46,h:0,mode:'rest',t:0,T:.24,x0:x,x1:x,h0:0,axis:[0,1,0],ang:0,Rt:null,
    spinAxis:[1,0,0],spinW:9,result:1,showFace:0,pulse:0,sq:0,sqV:0,crit:0,bounced:false,onLand:null,live:false,alpha:1,fade:false});
  function dieTarget(d,face){const f=d.geo.faces[face],N=vnorm([(Math.random()<.5?-1:1)*rnd(.22,.38),.46,1]),roll=rnd(-.22,.22);
    let U=[Math.sin(roll),Math.cos(roll),0];U=vnorm(vsub(U,vmul(N,vdot(N,U))));return frameRot(f.up,f.n,U,N)}
  function dieSet(d,n){d.n=n;d.geo=GEO[n];d.R=dieTarget(d,0);d.showFace=0;d.result=1;d.pulse=1}
  const die=mkDie(640),die2=mkDie(760),dieB=mkDie(520),die2B=mkDie(880),DICE=[dieB,die2B,die,die2]; // die2 is the other player's, in a duel; dieB and die2B are the second die of a hot round
  DICE.forEach(d=>dieSet(d,4));die.live=true;
  /* a hot round throws two: the second die stands outside the first, shows the throw that was not kept, and fades once it is down */
  function tossHot(d,b,hot,side){b.live=hot;b.alpha=1;b.fade=false;if(!hot)return;if(b.n!==d.n)dieSet(b,d.n);b.home=d.home+side*125;b.jit=d.jit;b.x=b.x1=b.home;dieToss(b)}
  function dieToss(d){d.mode='air';d.t=0;d.spinAxis=vnorm([rnd(-1,1),rnd(-.4,.4),rnd(-1,1)]);d.spinW=rnd(9,13)*(Math.random()<.5?-1:1);d.crit=0;
    d.vh=rnd(720,820);d.x1=d.home+rnd(-d.jit,d.jit);SFX.toss();dust(d.x,DIE_GY,4,.6)}
  function dieSlam(d,result,crit,onLand){d.mode='slam';d.t=0;d.result=result;d.showFace=result-1;d.Rt=dieTarget(d,result-1);
    const aa=axisAngle(mmul(d.R,mT(d.Rt)));d.axis=aa.axis;d.ang=aa.ang+TAU*(aa.ang<2?1:0);d.h0=d.h;d.x0=d.x;d.bounced=false;
    d.T=clamp(.2+d.h/1400,.2,.34);d.onLand=onLand;d.critNext=crit}
  function dieUpdate(d,dt,sp){
    d.pulse=Math.max(0,d.pulse-dt*4);d.crit=Math.max(0,d.crit-dt*1.2);if(d.fade)d.alpha=Math.max(.3,d.alpha-dt*2.5);
    d.sqV+=(-d.sq*420-d.sqV*22)*dt;d.sq+=d.sqV*dt;
    if(d.mode==='air'){d.t+=dt;d.vh-=2600*dt*(d.vh>0?1:.18);d.h=Math.max(0,d.h+d.vh*dt);
      if(d.h<=0&&d.vh<0){d.vh=520;dust(d.x,DIE_GY,3,.5);SFX.rattle();d.sqV-=5}
      d.x=lerp(d.x,d.x1,1-Math.exp(-dt*5));
      d.R=mmul(rodrigues(d.spinAxis,d.spinW*dt*Math.min(1.6,.8+sp*.25)),d.R)}
    else if(d.mode==='slam'){d.t+=dt;const u=clamp(d.t/d.T,0,1);
      const k=.72;let hh,e;
      if(u<k){const a=u/k;hh=d.h0*(1-a*a)}else{const a=(u-k)/(1-k);hh=34*4*a*(1-a);
        if(!d.bounced){d.bounced=true;dust(d.x,DIE_GY,7,1);SFX.thud(1);d.sqV-=9;G.shake=Math.max(G.shake,5)}}
      d.h=hh;e=1-u;d.R=mmul(rodrigues(d.axis,d.ang*e*e),d.Rt);d.x=lerp(d.x0,d.x1,u);
      if(u>=1){d.mode='rest';d.R=d.Rt;d.h=0;d.pulse=1;d.sqV-=6;dust(d.x,DIE_GY,5,.7);SFX.thud(.6);
        if(d.critNext)d.crit=1;const f=d.onLand;d.onLand=null;f&&f()}}
  }
  function hull2(pts){pts=pts.slice().sort((a,b)=>a[0]-b[0]||a[1]-b[1]);const cr=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]),lo=[],up=[];
    for(const p of pts){while(lo.length>1&&cr(lo[lo.length-2],lo[lo.length-1],p)<=0)lo.pop();lo.push(p)}
    for(const p of pts.slice().reverse()){while(up.length>1&&cr(up[up.length-2],up[up.length-1],p)<=0)up.pop();up.push(p)}
    lo.pop();up.pop();return lo.concat(up)}
  function dieView(d){const S=DIE_SCALE[d.n]*(1+d.pulse*.12),sy=1+d.sq,sx=1-d.sq*.6;
    const P=d.geo.V.map(v=>{const p=mapply(d.R,v);return[p[0]*S*sx,p[1]*S*sy,p[2]*S]});
    let mn=1e9;for(const p of P)mn=Math.min(mn,vdot(p,GN));return{P,S,Hc:-mn+d.h}}
  function drawDieShadow(d){const{P,Hc}=dieView(d),pts=[];
    for(const p of P){const q=vadd(p,vmul(GN,Hc)),hgt=vdot(q,GN),s=vadd(q,vmul(LDIR,hgt/-vdot(LDIR,GN)));pts.push([d.x+s[0],DIE_GY-s[1]])}
    const h=hull2(pts);ctx.beginPath();h.forEach((p,i)=>i?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]));ctx.closePath();
    ctx.fillStyle=`rgba(70,60,45,${clamp(.17-d.h*.0003,.07,.17)*d.alpha})`;ctx.fill()}
  function drawDie(d){const{P,S,Hc}=dieView(d),cx=d.x,cy=DIE_GY-Hc*GN[1],scr=P.map(p=>[cx+p[0],cy-p[1]]);ctx.save();ctx.globalAlpha=d.alpha;
    ctx.lineJoin='round';ctx.lineCap='round';
    const hl=hull2(scr);ctx.beginPath();hl.forEach((p,i)=>i?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]));ctx.closePath();ctx.lineWidth=9;ctx.strokeStyle=INK;ctx.stroke();
    const sy=1+d.sq,sx=1-d.sq*.6;
    d.geo.faces.forEach((f,fi)=>{const n=mapply(d.R,f.n);if(n[2]<=.01)return;
      const sh=.7+.3*Math.max(0,vdot(n,SHADE)),hot=d.mode==='rest'&&fi===d.showFace;
      const num=fi+1,kind=d.faces&&d.faces[num];let r=236*sh,g=222*sh,b=180*sh;if(kind){const c=FACE_RGB[kind];r=c[0]*sh;g=c[1]*sh;b=c[2]*sh}if(hot&&d.crit>0){const k=d.crit;r=lerp(r,255,k);g=lerp(g,205,k);b=lerp(b,70,k)}
      ctx.beginPath();f.idx.forEach((t,i)=>i?ctx.lineTo(scr[t][0],scr[t][1]):ctx.moveTo(scr[t][0],scr[t][1]));ctx.closePath();
      ctx.fillStyle=`rgb(${r|0},${g|0},${b|0})`;ctx.fill();ctx.lineWidth=4.5;ctx.strokeStyle=INK;ctx.stroke();
      if(n[2]<.18)return;
      const c=mapply(d.R,f.c),u=mapply(d.R,f.up),rt=vcross(u,n);
      ctx.save();ctx.transform(rt[0]*sx,-rt[1]*sy,-u[0]*sx,u[1]*sy,cx+c[0]*S*sx,cy-c[1]*S*sy);
      const fs=f.inr*S*(d.n===4?1.25:d.n===5&&f.idx.length===3?1.2:1.15)*(num>9?.8:1);
      if(kind){ctx.globalAlpha=clamp((n[2]-.18)*5,0,1)*d.alpha;ctx.translate(0,d.n===4?fs*.12:0);ctx.scale(fs/44,fs/44);ICON['f_'+kind]();ctx.restore();return} // a loaded face wears its mark, not its number
      ctx.font=`900 ${fs}px ${HUDF}`;ctx.textAlign='center';ctx.textBaseline='middle';if(LS)ctx.letterSpacing='0px';
      ctx.fillStyle=INK;ctx.globalAlpha=clamp((n[2]-.18)*5,0,1)*d.alpha;ctx.fillText(num+((num===6||num===9)&&d.n>8?'.':''),0,d.n===4?fs*.18:fs*.06);ctx.restore()});ctx.restore()}

  /* ---------- particles / fx / words ---------- */
  const parts=[],fx=[],words=[];
  function dust(x,y,n,pow){for(let i=0;i<n;i++){const a=rnd(0,TAU),s=rnd(40,150)*pow;parts.push({k:'puff',x:x+Math.cos(a)*20,y:y+Math.sin(a)*6+rnd(-4,8),vx:Math.cos(a)*s,vy:Math.sin(a)*s*.25-rnd(5,30),r:rnd(7,16)*pow,t:0,T:rnd(.35,.6)})}
    for(let i=0;i<n/2;i++)parts.push({k:'peb',x,y:y+rnd(0,10),vx:rnd(-160,160)*pow,vy:-rnd(60,220)*pow,r:rnd(2,4),t:0,T:rnd(.3,.5),gy:y+rnd(4,16)})}
  function heartsFx(x,y,n,col){for(let i=0;i<n;i++)parts.push({k:'heart',x:x+rnd(-30,30),y:y+rnd(-20,20),vx:rnd(-40,40),vy:-rnd(60,140),r:rnd(8,13),t:0,T:rnd(.6,.9),col})}
  function sparks(x,y,n,col){for(let i=0;i<n;i++){const a=rnd(0,TAU),s=rnd(200,520);parts.push({k:'spark',x,y,vx:Math.cos(a)*s,vy:Math.sin(a)*s,r:rnd(3,6),t:0,T:rnd(.18,.34),col})}}
  function burst(x,y,r,col){const sp=[];for(let i=0;i<20;i++)sp.push(i%2?rnd(.45,.6):rnd(.85,1.15));fx.push({k:'burst',x,y,r,col,sp,t:0,T:.24,rot:rnd(0,TAU)})}
  function ring(x,y,r){fx.push({k:'ring',x,y,r,t:0,T:.28})}
  function slash(x0,x1,y,col){fx.push({k:'slash',x0,x1,y,col,t:0,T:.13})}
  function chip(x,y,num,crit){fx.push({k:'chip',x,y,num,crit,t:0,T:.95})}
  function word(f,text,col=INK,size=30){const x=f.x,y0=GROUND-(f.cfg.wordY||250)*f.scale;let y=y0;for(const w of words)if(w.f===f&&w.t<.35)y-=34;
    words.push({f,text,col,size,x,y,t:0,T:.95})}
  const seen=new Set();
  function tips(){if(G.auto)return;for(const k of[G.bar.presses===2?'double':'',G.bar.v,G.bar.fog?'fog':'',...G.slots.map(s=>s.k)])if(k&&!seen.has(k)&&T('tip.'+k)!=='tip.'+k){seen.add(k);words.push({f:null,text:T('act.'+k),sub:T('tip.'+k),col:'#8a6a10',size:24,x:640,y:292,t:0,T:2.6});return}}
  function banner(text,sub){words.push({f:null,text,sub,col:INK,size:46,x:640,y:330,t:0,T:1.3})}

  /* ---------- drawing helpers ---------- */
  function shape(fill,fn,lw=5){ctx.beginPath();fn();if(fill){ctx.fillStyle=fill;ctx.fill()}if(lw){ctx.lineWidth=lw;ctx.strokeStyle=INK;ctx.lineJoin='round';ctx.lineCap='round';ctx.stroke()}}
  const ell=(x,y,rx,ry,r=0)=>ctx.ellipse(x,y,rx,ry,r,0,TAU);
  function rr(x,y,w,h,r){ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath()}
  function poly(p){p.forEach((q,i)=>i?ctx.lineTo(q[0],q[1]):ctx.moveTo(q[0],q[1]));ctx.closePath()}
  function line(x0,y0,x1,y1,lw=5,col=INK){ctx.beginPath();ctx.moveTo(x0,y0);ctx.lineTo(x1,y1);ctx.lineWidth=lw;ctx.strokeStyle=col;ctx.lineCap='round';ctx.stroke()}
  function txt(s,x,y,size,o={}){const cjk=lang==='zh';if(cjk&&size<12)size=Math.min(13,size*1.25); // a 9px hanzi is not readable, and Chinese is not tracked out
    ctx.font=`${o.w||700} ${size}px ${HUDF}`;ctx.textAlign=o.a||'center';ctx.textBaseline=o.b||'alphabetic';if(LS)ctx.letterSpacing=(cjk?0:o.ls||0)+'px';
    if(o.stroke){ctx.lineWidth=o.sw||6;ctx.strokeStyle=o.stroke;ctx.lineJoin='round';ctx.strokeText(s,x,y)}ctx.fillStyle=o.c||INK;ctx.fillText(s,x,y)}
  function heartPath(x,y,s){ctx.moveTo(x,y+s*.9);ctx.bezierCurveTo(x-s*1.5,y-s*.1,x-s*.8,y-s*1.1,x,y-s*.35);ctx.bezierCurveTo(x+s*.8,y-s*1.1,x+s*1.5,y-s*.1,x,y+s*.9);ctx.closePath()}
  function eye(x,y,r,ex,col='#fff',plain=false){
    if(ex==='x'){const c=plain?col:INK;line(x-r*.7,y-r*.7,x+r*.7,y+r*.7,4.5,c);line(x-r*.7,y+r*.7,x+r*.7,y-r*.7,4.5,c);return}
    if(ex==='happy'){ctx.beginPath();ctx.arc(x,y+r*.4,r*.85,Math.PI*1.1,Math.PI*1.9);ctx.lineWidth=4.5;ctx.strokeStyle=plain?col:INK;ctx.lineCap='round';ctx.stroke();return}
    if(plain){shape(col,()=>ell(x,y,r*.75,ex==='angry'?r*.6:r),0);if(ex==='angry'){shape(INK,()=>poly([[x-r,y-r*1.2],[x+r,y-r*.2],[x+r,y-r*1.4]]),0)}return}
    shape(col,()=>ell(x,y,r,r*1.08),4);shape(INK,()=>ell(x+r*.3,y+r*.05,r*.42,r*.48),0);
    if(ex==='angry')line(x-r*1.1,y-r*1.45,x+r*1.0,y-r*.7,5)}
  function mouth(x,y,w,open,teeth){if(open){shape('#7a2b2b',()=>ell(x,y,w*.5,w*.34));if(teeth)shape('#fff',()=>rr(x-w*.3,y-w*.32,w*.6,w*.2,2),2.5)}
    else{ctx.beginPath();ctx.moveTo(x-w*.5,y-3);ctx.quadraticCurveTo(x,y+w*.35,x+w*.5,y-5);ctx.lineWidth=4.5;ctx.strokeStyle=INK;ctx.lineCap='round';ctx.stroke();
      if(teeth)shape('#fff',()=>poly([[x+w*.15,y+w*.08],[x+w*.3,y+w*.02],[x+w*.26,y+w*.3]]),2.5)}}

  /* ---------- heads (origin = head centre, facing +x) ---------- */
  const HEADS={
    helm(ex,o,t,f){const sway=Math.sin(t*3)*4-f.leanV*6;
      shape(f.cfg.plume||'#d8503a',()=>{ctx.moveTo(-4,-48);ctx.bezierCurveTo(-20,-84,-60+sway,-80,-70+sway,-52);ctx.bezierCurveTo(-52+sway,-64,-34,-58,-18,-40);ctx.closePath()});
      shape('#e9e2cf',()=>{ctx.moveTo(-42,34);ctx.lineTo(-44,-18);ctx.bezierCurveTo(-44,-62,44,-62,44,-18);ctx.lineTo(42,34);ctx.quadraticCurveTo(0,46,-42,34);ctx.closePath()});
      ctx.save();ctx.beginPath();ctx.moveTo(-42,34);ctx.lineTo(-44,-18);ctx.bezierCurveTo(-44,-62,44,-62,44,-18);ctx.lineTo(42,34);ctx.closePath();ctx.clip();
      ctx.fillStyle='rgba(120,105,80,.22)';ctx.fillRect(-50,-70,26,130);ctx.restore();
      shape(INK,()=>rr(-16,-16,58,27,11),0);line(12,-50,12,-18,4);line(12,12,12,38,4);
      eye(4,-2,7.5,ex,'#fff',true);eye(27,-2,7.5,ex,'#fff',true);
      for(const x of[-30,-6,30])shape(INK,()=>ell(x,27,2.5,2.5),0)},
    goblin(ex,o){shape('#7fae4e',()=>poly([[-28,-10],[-82,-34],[-34,16]]));shape('#7fae4e',()=>poly([[24,-14],[70,-44],[36,10]]));
      shape('#8fbf5a',()=>ell(0,0,42,37));eye(-8,-8,10,ex,'#ffe27a');eye(20,-8,10,ex,'#ffe27a');shape('#7fae4e',()=>ell(40,4,9,7));mouth(10,16,40,o,true)},
    pumpkin(ex,o){shape('#5d8a3c',()=>rr(-7,-52,14,18,4));shape('#e8892f',()=>ell(0,0,48,39));
      ctx.beginPath();ctx.ellipse(0,0,24,39,0,0,TAU);ctx.lineWidth=3;ctx.strokeStyle='rgba(37,35,31,.35)';ctx.stroke();
      if(ex==='x'||ex==='happy'){eye(-12,-8,9,ex);eye(20,-8,9,ex)}else{shape('#ffd84a',()=>poly([[-22,-2],[-10,-20],[-2,-2]]),4);shape('#ffd84a',()=>poly([[10,-2],[22,-20],[32,-2]]),4)}
      shape(o?'#7a2b2b':'#ffd84a',()=>poly([[-22,10],[-12,16],[-2,9],[8,16],[18,9],[30,12],[20,o?32:24],[8,o?28:19],[-2,o?32:25],[-12,o?27:19]]),4)},
    cyclops(ex,o){shape('#efe6cf',()=>poly([[-10,-34],[2,-72],[16,-32]]));shape('#9a78c9',()=>ell(0,0,41,40));eye(8,-8,18,ex);
      mouth(8,22,34,o,false);if(!o){shape('#fff',()=>poly([[-4,20],[2,10],[7,21]]),2.5);shape('#fff',()=>poly([[14,21],[19,10],[25,19]]),2.5)}},
    crow(ex,o){shape('#f2b632',()=>o?poly([[26,-12],[86,-10],[30,2],[80,18],[26,16]]):poly([[26,-12],[88,4],[26,16]]));shape('#3a3840',()=>ell(0,0,37,36));
      eye(10,-8,11,ex);shape('#3a3840',()=>rr(-24,-74,48,40,5));shape(RED,()=>rr(-24,-48,48,10,1),3.5);shape(INK,()=>rr(-50,-40,100,11,5),0)},
    robot(ex,o,t){line(0,-38,0,-60,5);shape(Math.sin(t*6)>0?RED:'#8a3a34',()=>ell(0,-64,7,7),4);shape('#9fb4c4',()=>rr(-40,-38,82,74,12));
      shape('#2f3a40',()=>rr(-28,-26,62,28,6),3.5);eye(-10,-12,7,ex,'#8ef0c0',true);eye(18,-12,7,ex,'#8ef0c0',true);
      shape('#efe6cf',()=>rr(-14,12,42,o?20:12,4),3.5);for(const x of[-3,7,17])line(x,13,x,o?31:23,3);
      shape('#6c8494',()=>ell(-42,0,6,10),4)},
    toad(ex,o){shape('#6fae7a',()=>ell(0,4,60,38));shape('#6fae7a',()=>ell(-24,-30,18,18));shape('#6fae7a',()=>ell(28,-30,18,18));
      eye(-22,-31,11,ex,'#ffe27a');eye(30,-31,11,ex,'#ffe27a');
      shape(YEL,()=>poly([[-16,-42],[-18,-72],[-6,-58],[3,-78],[12,-58],[24,-72],[22,-42]]));
      if(o){shape('#7a2b2b',()=>ell(6,16,40,17));shape('#e58a9a',()=>ell(10,24,18,8),3)}else{ctx.beginPath();ctx.moveTo(-44,10);ctx.quadraticCurveTo(6,34,52,8);ctx.lineWidth=5;ctx.strokeStyle=INK;ctx.stroke()}
      shape('#5c9968',()=>ell(-36,14,5,4),0);shape('#5c9968',()=>ell(44,20,4,3),0)},
  };
  const WEAPONS={
    sword(){shape('#efe6cf',()=>poly([[-6,-12],[-6,-74],[0,-88],[6,-74],[6,-12]]));line(0,-16,0,-70,2.5,'rgba(37,35,31,.3)');shape(YEL,()=>rr(-17,-14,34,9,4));shape(INK,()=>rr(-4,-6,8,18,3),0);shape(YEL,()=>ell(0,14,6,6),4)},
    club(){shape('#a9784a',()=>{ctx.moveTo(-5,10);ctx.lineTo(-13,-66);ctx.quadraticCurveTo(0,-86,13,-66);ctx.lineTo(5,10);ctx.closePath()});for(const p of[[-6,-58],[5,-44],[-2,-30]])shape('#efe6cf',()=>ell(p[0],p[1],3.5,3.5),3)},
    scythe(){line(0,16,0,-84,7);shape('#efe6cf',()=>{ctx.moveTo(0,-84);ctx.quadraticCurveTo(44,-92,62,-54);ctx.quadraticCurveTo(36,-72,0,-68);ctx.closePath()})},
    staff(){line(0,18,0,-78,7);shape('#8fd8e8',()=>ell(0,-88,12,12))},
    dagger(){shape('#efe6cf',()=>poly([[-5,-10],[-5,-44],[0,-56],[5,-44],[5,-10]]));shape(RED,()=>rr(-13,-12,26,8,4));shape(INK,()=>rr(-4,-5,8,14,3),0)},
    wrench(){line(0,14,0,-54,9);shape('#9fb4c4',()=>{ctx.arc(0,-68,17,Math.PI*.75-Math.PI/2,Math.PI*2.25-Math.PI/2);ctx.lineTo(0,-64);ctx.closePath()})},
    scepter(){line(0,18,0,-74,7,INK);line(0,16,0,-72,3,YEL);shape(RED,()=>poly([[0,-100],[13,-84],[0,-68],[-13,-84]]))},
  };
  const POSE={
    idle:{lean:0,ox:0,oy:0,hF:[42,-78],hB:[-36,-70],w:.55,ex:'n'},
    attack:{lean:.3,ox:74,oy:0,hF:[94,-104],hB:[-54,-60],w:1.7,ex:'angry',o:1},
    block:{lean:-.08,ox:-8,oy:0,hF:[54,-100],hB:[-30,-84],w:-.5,ex:'angry',shield:1},
    hurt:{lean:-.4,ox:-40,oy:0,hF:[-8,-152],hB:[-66,-128],w:-1,ex:'x',o:1},
    dodge:{lean:-.32,ox:-86,oy:-50,hF:[30,-124],hB:[-52,-112],w:-.6,ex:'happy'},
    threat:{lean:.12,ox:26,oy:0,hF:[64,-180],hB:[-60,-174],w:.1,ex:'angry',o:1},
    heal:{lean:-.05,ox:0,oy:-16,hF:[46,-168],hB:[-46,-166],w:-.3,ex:'happy'},
    miss:{lean:.5,ox:36,oy:0,hF:[72,-40],hB:[-20,-124],w:2.3,ex:'x',o:1},
    cheer:{lean:0,ox:0,oy:-34,hF:[52,-184],hB:[-52,-178],w:-.2,ex:'happy',o:1},
    zoom:{lean:.22,ox:12,oy:-12,hF:[30,-58],hB:[-62,-66],w:1.2,ex:'happy'},
    slow:{lean:-.12,ox:-4,oy:0,hF:[38,-58],hB:[-38,-58],w:.9,ex:'happy'},
    daze:{lean:.14,ox:0,oy:0,hF:[30,-50],hB:[-34,-50],w:1.4,ex:'x'},
    ko:{lean:-1.5,ox:40,oy:0,hF:[-20,-160],hB:[-70,-140],w:-1.2,ex:'x',o:1},
  };
  /* how each rung of foes.js's ladder looks (its hearts, its die and its brain are over there), and the hero. Names are strings.js's.
     A solo fighter is pictures, one for each of FRAMES (art/<img>-<frame>.png, all cut from one sheet so they are to one scale; the idle
     one stands SPR_H tall at scale 1, feet on the ground) and FRAME_OF says which one a pose is. `dir` is the way the drawings face,
     `ax` where the feet stand across each picture (in FRAMES' order), `sw` its shadow, `bub` how far off the intent bubble sits,
     `face` the portrait's [cx, cy, r] on the idle one (r in heights). The shapes beside it are what is drawn until the pictures are in. */
  const SPR_H=225,FRAMES=['idle','attack','guard','hurt','cheer','ko'];
  const FRAME_OF={idle:'idle',slow:'idle',zoom:'idle',attack:'attack',block:'guard',dodge:'guard',hurt:'hurt',miss:'hurt',daze:'hurt',threat:'cheer',heal:'cheer',cheer:'cheer',ko:'ko'};
  const LEAN_K={idle:1,attack:.35,guard:.35,hurt:.35,cheer:.5,ko:0}; // a picture that leans already is leant less; one that lies down is not tipped over
  const LOOK={
    daisy:{img:'daisy',dir:-1,sw:58,ax:[.535,.622,.498,.643,.563,.5],face:[.5,.24,.2],head:'goblin',body:'bell',col:'#8a5a3c',trim:'#d9b24a',glove:'#8fbf5a',weapon:'club',scale:1},
    blot:{img:'blot',dir:-1,sw:66,ax:[.511,.762,.499,.619,.531,.5],face:[.38,.2,.16],head:'pumpkin',body:'round',col:'#4d6b3a',trim:'#e8892f',glove:'#efe6cf',weapon:'scythe',scale:1.1},
    caw:{img:'caw',dir:-1,sw:62,ax:[.51,.546,.474,.664,.498,.5],face:[.4,.3,.16],head:'crow',body:'bell',col:'#3a3840',trim:RED,glove:'#f2b632',weapon:'dagger',scale:1.1},
    moss:{img:'moss',dir:-1,sw:96,bub:128,ax:[.481,.685,.504,.464,.5,.5],face:[.35,.33,.2],head:'cyclops',body:'round',col:'#c9a063',trim:'#7a5a9a',glove:'#9a78c9',weapon:'club',scale:1.08},
    puppet:{img:'puppet',dir:-1,sw:60,ax:[.502,.586,.499,.69,.522,.5],face:[.4,.2,.15],head:'robot',body:'box',col:'#9fb4c4',trim:YEL,glove:'#6c8494',weapon:'wrench',scale:1.15},
    grin:{img:'grin',dir:-1,sw:78,bub:110,ax:[.551,.644,.593,.577,.418,.5],face:[.4,.17,.16],head:'cyclops',body:'round',col:'#efe6cf',trim:'#d9b24a',glove:'#efe6cf',weapon:'club',scale:1.1},
    frost:{img:'frost',dir:-1,sw:70,ax:[.528,.676,.527,.365,.495,.5],face:[.42,.33,.2],head:'crow',body:'bell',col:'#2f4f9a',trim:'#9ad0ee',glove:'#25231f',weapon:'scepter',scale:1},
    ram:{img:'ram',dir:-1,sw:60,ax:[.488,.627,.562,.633,.506,.5],face:[.5,.17,.14],head:'toad',body:'round',col:'#2b3a66',trim:YEL,glove:'#25231f',weapon:'scepter',scale:1.38,wordY:240},
  };
  const HERO={id:'hero',img:'hero',dir:1,sw:64,ax:[.539,.296,.481,.572,.378,.5],face:[.57,.34,.2],head:'helm',body:'bell',col:'#2f8f83',trim:YEL,glove:'#efe6cf',weapon:'sword',scale:.95};
  /* the pictures: asked for once, up front. `lit` is the same picture all white, for the flash of a hit, made the first time it is wanted */
  const ART={};
  for(const c of[HERO,...Object.values(LOOK)]){ART[c.img]={};for(const k of FRAMES){const a=ART[c.img][k]={img:new Image(),lit:null,ok:false};a.img.onload=()=>{a.ok=true};a.img.src=new URL('./art/'+c.img+'-'+k+'.png',import.meta.url).href}}
  function litOf(a){if(!a.lit){const k=a.lit=document.createElement('canvas');k.width=a.img.naturalWidth;k.height=a.img.naturalHeight;const x=k.getContext('2d');x.drawImage(a.img,0,0);x.globalCompositeOperation='source-in';x.fillStyle='#fff';x.fillRect(0,0,k.width,k.height)}return a.lit}
  /* the picture for a fighter's pose: { a, k, idle }, the idle one while another is not in yet, null while that is not (or for a drawn fighter) */
  function artOf(f,pose='idle'){const set=f.cfg.img&&ART[f.cfg.img];if(!set||!set.idle.ok)return null;const k=FRAME_OF[pose]||'idle',a=set[k].ok?set[k]:set.idle;return{a,k:a===set.idle?'idle':k,idle:set.idle}}
  const nameOf=f=>f.cfg.name||T('name.'+f.cfg.id); // a player's own name, or a CPU fighter's in this screen's language

  function mkFighter(cfg,x,face){return{cfg,x,homeX:x,face,scale:cfg.scale,hp:6,maxHp:6,die:4,toHit:3,combo:0,pose:'idle',poseT:0,
    lean:0,leanV:0,ox:0,oxV:0,oy:0,oyV:0,sy:1,syV:0,hFx:42,hFxV:0,hFy:-78,hFyV:0,hBx:-36,hBxV:0,hBy:-70,hByV:0,w:.55,wV:0,
    flash:0,shake:0,stun:false,intent:'attack',hidden:false,alpha:1,hpPop:0,rolled:0,landed:1}}
  function setPose(f,p,dur=.5){if(f.pose==='ko'&&p!=='idle')return;f.pose=p;f.poseT=dur;f.syV+=p==='attack'||p==='threat'||p==='cheer'?4:-4}
  function spr(o,k,target,dt,st,dm){const v=k+'V';o[v]+=((target-o[k])*st-o[v]*dm)*dt;o[k]+=o[v]*dt}
  function updFighter(f,dt,t,sp){if(f.poseT>0&&f.pose!=='ko'){f.poseT-=dt;if(f.poseT<=0)f.pose=f.stun?'daze':'idle'}
    const p=POSE[f.pose],S=330,D=21;spr(f,'lean',p.lean+(f.pose==='daze'?Math.sin(t*5)*.1:0),dt,S,D);spr(f,'ox',p.ox,dt,S,D);spr(f,'oy',p.oy,dt,S,D);
    spr(f,'sy',1+(f.pose==='idle'?Math.sin(t*(3.2+sp*1.6)+f.homeX)*.022:0),dt,420,14);
    spr(f,'hFx',p.hF[0],dt,S,D);spr(f,'hFy',p.hF[1]+(f.pose==='idle'?Math.sin(t*(3.2+sp*1.6)+f.homeX+1)*4:0),dt,S,D);spr(f,'hBx',p.hB[0],dt,S,D);spr(f,'hBy',p.hB[1],dt,S,D);spr(f,'w',p.w,dt,S,D);
    f.flash=Math.max(0,f.flash-dt*5);f.shake=Math.max(0,f.shake-dt*3.5);f.hpPop=Math.max(0,f.hpPop-dt*3);f.x+=(f.homeX-f.x)*(1-Math.exp(-dt*6));
    if(!f.landed&&Math.abs(f.homeX-f.x)<10){f.landed=1;f.syV-=3;dust(f.x,GROUND+2,8,.7)}} // walked on: a puff where it stops
  function arm(sx,sy,hx,hy,bend){const mx=(sx+hx)/2,my=(sy+hy)/2,dx=hx-sx,dy=hy-sy,l=Math.hypot(dx,dy)||1,k=Math.max(0,62-l)*.6+10;
    ctx.beginPath();ctx.moveTo(sx,sy);ctx.quadraticCurveTo(mx-dy/l*k*bend,my+dx/l*k*bend,hx,hy);ctx.lineWidth=9;ctx.strokeStyle=INK;ctx.lineCap='round';ctx.stroke()}
  function drawFighterShadow(f){ctx.fillStyle='rgba(70,60,45,.13)';ctx.beginPath();const s=f.scale*clamp(1+f.oy/200,.6,1);
    const sw=f.cfg.sw||70;ctx.ellipse(f.x+f.ox*f.face*.8,GROUND+4,(f.pose==='ko'?sw*1.35:sw)*s,11*s,0,0,TAU);ctx.globalAlpha=f.alpha;ctx.fill();ctx.globalAlpha=1}
  function drawFighter(f,t){const c=f.cfg,p=POSE[f.pose];ctx.save();ctx.globalAlpha=f.alpha;
    ctx.translate(f.x+f.ox*f.face+(f.shake>0?rnd(-1,1)*f.shake*12:0),GROUND+f.oy);ctx.scale(f.face*f.scale,f.scale);const A=artOf(f,f.pose);ctx.rotate(A?f.lean*LEAN_K[A.k]:f.lean);ctx.scale(2-f.sy,f.sy);
    if(A){const im=A.a.img,h=SPR_H*im.naturalHeight/A.idle.img.naturalHeight,w=h*im.naturalWidth/im.naturalHeight,x0=-w*c.ax[FRAMES.indexOf(A.k)],sway=f.pose==='idle'?Math.sin(t*2.1+f.homeX)*.018:0; // pictures: the pose picks one, the springs move it whole
      ctx.rotate(sway);ctx.scale(c.dir,1);ctx.drawImage(im,x0,6-h,w,h);if(f.flash>0){ctx.globalAlpha=f.alpha*Math.min(1,f.flash*.8);ctx.drawImage(litOf(A.a),x0,6-h,w,h)}
      ctx.restore();return}
    // legs + feet
    const st=f.pose==='attack'?16:0;
    line(-13,-52,-20-st,-6,9);line(13,-52,22+st,-6,9);shape(INK,()=>ell(-16-st,-4,17,8),0);shape(INK,()=>ell(27+st,-4,17,8),0);
    arm(-20,-106,f.hBx,f.hBy,1);shape(c.glove,()=>ell(f.hBx,f.hBy,11,11),4.5);
    if(c.body==='bell'){shape(c.col,()=>{ctx.moveTo(-26,-124);ctx.quadraticCurveTo(-54,-72,-52,-42);ctx.quadraticCurveTo(0,-30,52,-42);ctx.quadraticCurveTo(54,-72,26,-124);ctx.closePath()});
      ctx.beginPath();ctx.moveTo(-47,-52);ctx.quadraticCurveTo(0,-40,47,-52);ctx.lineWidth=6;ctx.strokeStyle=c.trim;ctx.stroke();line(-38,-86,38,-86,5);shape(c.trim,()=>rr(-7,-93,14,14,3),3.5)}
    else if(c.body==='round'){shape(c.col,()=>ell(0,-84,48,46));ctx.beginPath();ctx.ellipse(0,-84,48,46,0,.25,Math.PI-.25);ctx.lineWidth=6;ctx.strokeStyle=c.trim;ctx.stroke();shape(c.col,()=>ell(0,-84,48,46),5);shape(c.trim,()=>ell(8,-84,6,6),3.5)}
    else{shape(c.col,()=>rr(-42,-126,84,84,12));shape('#2f3a40',()=>rr(-22,-108,44,30,5),3.5);shape(c.trim,()=>ell(-8,-93,5,5),0);shape(RED,()=>ell(8,-93,5,5),0);line(-26,-62,26,-62,4)}
    // head
    ctx.save();ctx.translate(2,-160);ctx.rotate(-f.lean*.45);HEADS[c.head](f.pose==='idle'&&f.hp<=2&&f.hp>0?'angry':p.ex,!!p.o,t,f);ctx.restore();
    // front arm + weapon/shield
    arm(22,-106,f.hFx,f.hFy,-1);
    ctx.save();ctx.translate(f.hFx,f.hFy);
    if(p.shield){shape('#efe6cf',()=>ell(10,0,34,38));shape(c.trim,()=>ell(10,0,22,25),4);shape(INK,()=>ell(10,0,6,6),0)}
    else{ctx.rotate(f.w);WEAPONS[c.weapon]()}
    ctx.restore();shape(c.glove,()=>ell(f.hFx,f.hFy,12,12),4.5);
    ctx.restore();
    if(f.flash>0){ctx.save();ctx.globalAlpha=f.flash*.55;ctx.fillStyle='#fff';ctx.beginPath();ctx.ellipse(f.x+f.ox*f.face,GROUND-120*f.scale,90*f.scale,130*f.scale,0,0,TAU);ctx.fill();ctx.restore()}
  }

  /* ---------- icons ---------- */
  const ICON={
    sword(){ctx.rotate(.7);shape('#efe6cf',()=>poly([[-5,6],[-5,-20],[0,-28],[5,-20],[5,6]]),3.5);shape(YEL,()=>rr(-12,6,24,6,3),3.5);shape(INK,()=>rr(-3,12,6,10,2),0);shape(YEL,()=>ell(0,24,4,4),3)},
    shield(){shape('#efe6cf',()=>{ctx.moveTo(-15,-17);ctx.lineTo(15,-17);ctx.lineTo(15,2);ctx.quadraticCurveTo(13,15,0,22);ctx.quadraticCurveTo(-13,15,-15,2);ctx.closePath()},3.5);
      shape(YEL,()=>{ctx.moveTo(-5,-13);ctx.lineTo(5,-13);ctx.lineTo(5,13);ctx.lineTo(0,16);ctx.lineTo(-5,13);ctx.closePath()},3)},
    skull(){shape('#efe6cf',()=>rr(-9,4,18,13,4),3.5);shape('#efe6cf',()=>ell(0,-5,16,14),3.5);shape(INK,()=>ell(-6,-4,4.5,5),0);shape(INK,()=>ell(6,-4,4.5,5),0);shape(INK,()=>poly([[0,2],[-2.5,7],[2.5,7]]),0);line(-3,11,-3,16,2.5);line(3,11,3,16,2.5)},
    heart(){shape(RED,()=>heartPath(0,-1,15),3.5);ctx.beginPath();ctx.arc(-7,-7,4,Math.PI,Math.PI*1.6);ctx.lineWidth=3;ctx.strokeStyle='rgba(255,255,255,.7)';ctx.stroke()},
    fast(){for(const x of[-13,3])shape(YEL,()=>poly([[x,-14],[x+16,0],[x,14]]),3.5)},
    slow(){for(const x of[13,-3])shape(YEL,()=>poly([[x,-14],[x-16,0],[x,14]]),3.5)},
    mystery(){txt('?',0,13,38,{w:900,c:YEL,stroke:INK,sw:7})},
    leech(){shape(RED,()=>{ctx.moveTo(0,-20);ctx.quadraticCurveTo(15,2,11,11);ctx.quadraticCurveTo(0,24,-11,11);ctx.quadraticCurveTo(-15,2,0,-20);ctx.closePath()},3.5);shape('#fff',()=>poly([[-7,4],[-3,15],[0,5]]),2.5);shape('#fff',()=>poly([[0,5],[3,15],[7,4]]),2.5)},
    counter(){ctx.lineWidth=5;ctx.strokeStyle=INK;ctx.lineCap='round';ctx.beginPath();ctx.arc(0,0,13,Math.PI*.15,Math.PI*1.05);ctx.stroke();ctx.beginPath();ctx.arc(0,0,13,Math.PI*1.15,Math.PI*2.05);ctx.stroke();shape(YEL,()=>poly([[-19,-6],[-8,-4],[-15,5]]),3);shape(YEL,()=>poly([[19,6],[8,4],[15,-5]]),3)},
    poison(){shape('#8fbf5a',()=>{ctx.moveTo(0,-20);ctx.quadraticCurveTo(15,2,11,11);ctx.quadraticCurveTo(0,24,-11,11);ctx.quadraticCurveTo(-15,2,0,-20);ctx.closePath()},3.5);shape(INK,()=>ell(-4,5,2.6,3.2),0);shape(INK,()=>ell(4,5,2.6,3.2),0);line(-4,13,4,13,2.5)},
    f_vamp(){ICON.leech()},f_venom(){ICON.poison()},f_guard(){ICON.shield()},f_lucky(){ICON.star()},f_double(){txt('×2',0,13,36,{w:900,c:'#d0521f',stroke:INK,sw:6})},
    smoke(){shape('#3a3448',()=>{ctx.moveTo(-9,-4);ctx.lineTo(-5,-18);ctx.lineTo(5,-18);ctx.lineTo(9,-4);ctx.quadraticCurveTo(15,4,13,14);ctx.quadraticCurveTo(0,22,-13,14);ctx.quadraticCurveTo(-15,4,-9,-4);ctx.closePath()},3.5);shape('#efe6cf',()=>rr(-7,-23,14,7,2),3);shape('#7a5a9a',()=>ell(0,8,7,5),0)},
    charge(){txt('!!',0,14,40,{w:900,c:RED,stroke:INK,sw:7})},
    jackpot(){shape('#ffd84a',()=>ell(0,0,17,17),3.5);shape('#fff3b0',()=>ell(-5,-6,5,4),0);ctx.save();ctx.scale(.55,.55);const p=[];for(let i=0;i<10;i++){const a=i*TAU/10-Math.PI/2,r=i%2?9:20;p.push([Math.cos(a)*r,Math.sin(a)*r])}shape('#e08a1e',()=>poly(p),3.5);ctx.restore()},
    bomb(){const fl=Math.sin(performance.now()/50)>0;ctx.beginPath();ctx.moveTo(7,-12);ctx.quadraticCurveTo(12,-24,20,-20);ctx.lineWidth=3.5;ctx.strokeStyle=INK;ctx.lineCap='round';ctx.stroke();
      shape('#3a3630',()=>ell(-1,3,15,15),3.5);shape('#6d685c',()=>ell(-6,-3,4,3),0);shape('#3a3630',()=>rr(2,-15,9,7,2),3);shape(fl?'#ffcd46':'#f08a4b',()=>ell(21,-21,fl?5:3.5,fl?5:3.5),2.5)},
    dodge(){ctx.beginPath();ctx.moveTo(14,12);ctx.quadraticCurveTo(-18,14,-14,-10);ctx.lineWidth=5;ctx.strokeStyle=INK;ctx.lineCap='round';ctx.stroke();shape(INK,()=>poly([[-24,-6],[-12,-22],[-4,-4]]),0);line(2,-8,16,-8,4);line(6,0,18,0,4)},
    stun(){for(let i=0;i<3;i++){const a=i*TAU/3+performance.now()/300;shape(YEL,()=>ell(Math.cos(a)*14,Math.sin(a)*7,5,5),3)}},
    attack(){ICON.sword()},block(){ICON.shield()},
    die(){shape('#efe6cf',()=>poly([[0,-20],[18,-8],[18,12],[0,22],[-18,12],[-18,-8]]),3.5);line(0,2,0,22,3);line(0,2,18,-8,3);line(0,2,-18,-8,3)},
    star(){const p=[];for(let i=0;i<10;i++){const a=i*TAU/10-Math.PI/2,r=i%2?9:20;p.push([Math.cos(a)*r,Math.sin(a)*r])}shape(YEL,()=>poly(p),3.5)},
    book(){shape('#8fd8e8',()=>rr(-16,-18,32,36,4),3.5);line(-8,-18,-8,18,3);line(0,-8,10,-8,3);line(0,0,10,0,3)},
  };
  function icon(k,x,y,s=1){ctx.save();ctx.translate(x,y);ctx.scale(s,s);ICON[k]();ctx.restore()}

  /* ---------- perks (perks.js): BIGGER DIE is the view's own, it swaps the polyhedron ---------- */
  const faceCard=c=>({id:'face',icon:'f_'+c.kind,nk:'face.'+c.kind,dk:'face.'+c.kind+'.d',vars:{n:c.face},card:c,f:h=>{carve(h,c);SFX.carve()}});
  const BIGDIE={id:'big',icon:'die',vars:{},f:()=>{P.die=G.die=DIE_STEPS[DIE_STEPS.indexOf(P.die)+1];dieSet(die,P.die)}};

  /* ---------- game state ---------- */
  const G={state:'title',auto:true,phase:'intro',t:0,pt:0,shake:0,hitStop:0,score:0,best:0,stage:0,lvl:1,xp:0,need:14,pendingLvl:0,xpMul:1,die:4,
    bar:{v:'still',slots:[]},slots:[],cursor:0,pressed:false,pressU:0,hitSlot:-1,picks:[],firstSlot:-1,autoMode:'',autoT:-1,lastSlot:-1,grade:'',gradeSub:'',gradeT:9,gradeCol:INK,perks:[],perkT:0,perkPicked:-1,
    deadT:0,kills:0,idleT:0,maxCombo:0,barShake:0,flashBG:0,pitch:1};
  try{G.best=+localStorage.getItem('loadedDiceBest')||0}catch(e){}
  let P=mkFighter(HERO,230,1),E=mkFighter({...LOOK.daisy,id:'daisy'},1050,-1);
  /* the solo run's rules: the hero and the foe as rules.js duelists, the run's own dice, and the round that was just played. P and E
     are what is drawn; they catch up with these (`syncSolo`) when the die has landed, the way a duel's catch up with the host. */
  const SOLO={rnd:null,hero:null,foe:null,R:null,turn:null,feat:featsFor('classic')},DEF_MODS=mkMods();
  const perfNow=()=>Math.min(1,MODS().perfW*(P.hot?2:1)); // a hot round's sweet spots are twice as wide
  const MODS=()=>!V.on&&SOLO.hero?SOLO.hero.mods:DEF_MODS;
  /* the duel as this screen sees it: `me` is my index in the room's first two players, P is always me and E the other one */
  const V={on:false,fever:false,draft:null,me:0,m:0,d:1,n:0,rn:0,target:1,oppSlots:[],oppLocked:false,oppHit:-1,oppAct:'',res:null,landed:0,helloT:0,over:false};
  let session=null,isHost=false,online=false,hostId=null;

  function speed(){return P.sp||1}
  function eSpeed(){return 1+E.combo*.08}
  function pressure(){return V.on?speed():speed()+(eSpeed()-1)*.5}
  function syncSolo(){const h=SOLO.hero,f=SOLO.foe.f;P.hp=h.hp;P.maxHp=h.maxHp;P.combo=h.combo;P.sp=speedOf(h);P.fever=h.fever;P.poison=h.poison;E.poison=f.poison;die.faces=dieB.faces=h.mods.faces;E.hp=f.hp;E.maxHp=f.maxHp;E.combo=f.combo;E.stun=f.dazed}
  function resetRun(auto){G.auto=auto;G.state=auto?'title':'play';Object.assign(G,{score:0,stage:0,lvl:1,xp:0,need:14,pendingLvl:0,xpMul:1,die:4,kills:0,maxCombo:0,grade:'',gradeT:9});
    SOLO.rnd=makeRng((Math.random()*4294967296)>>>0).rnd;SOLO.hero=mkHero();
    P=mkFighter(HERO,230,1);die.home=640;die.jit=46;dieSet(die,4);words.length=0;fx.length=0;spawnEnemy()}
  function spawnEnemy(){const s=G.stage,F=SOLO.foe=mkFoe(s);SOLO.feat=featsFor(session?.opts?.spice||'std',s>=4?3:s>=2?2:1); // a run brings the new things in stage by stage
    E=mkFighter({...LOOK[F.cfg.id],id:F.cfg.id},1050,-1);E.x=1400;E.landed=0;E.die=F.die;E.toHit=F.cfg.toHit;E.tier=F.tier;syncSolo();
    G.phase='intro';G.pt=.85;setBar({v:'still',slots:[]});banner(T('stage',{n:s+1}),T('stageSub',{name:nameOf(E)+(F.tier?' +'+F.tier:''),die:E.die,hit:E.toHit}))}
  function addXP(n){G.xp+=n*G.xpMul;while(G.xp>=G.need){G.xp-=G.need;G.lvl++;G.need=Math.round(14+G.lvl*7);G.pendingLvl++}}
  function addScore(n){G.score+=Math.round(n*speed())}

  /* the foe's intent is drawn first (the bubble shows it, unless it is one who hides it), and the hero's bar leans against it */
  function newRound(){const F=SOLO.foe,h=SOLO.hero,feat=SOLO.feat,turn=SOLO.turn=foeTurn(SOLO.rnd,F,feat.tricks);E.intent=turn.intent;if(E.intent==='stun'){E.pose='daze';E.poseT=0}else if(E.pose==='daze')E.pose='idle';E.stun=false;
    E.hidden=E.intent!=='stun'&&!turn.trick&&SOLO.rnd()<F.cfg.hide;if(turn.angry){E.die=F.die;banner(T('trick.angry'),T('trick.angry.d',{die:F.die}));SFX.spook();G.shake=14;setPose(E,'threat',.8)}else if(turn.trick){word(E,T('trick.'+turn.trick),'#7a5a9a',30);if(turn.trick!=='flurry'&&turn.trick!=='smash')SFX.spook()}
    let slots=turn.swallow?[]:genSlots(SOLO.rnd,h,G.stage+1,{...slotHint(F.f,F.cfg,E.intent),smoke:0},feat);if(turn.steal)slots=stealSlot(slots); // ink is no use against a foe with no bar
    setBar(mkBar(SOLO.rnd,slots,feat,h.fogged||turn.fog,turn.bar||(isDouble(SOLO.rnd,feat)?{presses:2}:null)));G.blank=turn.blank;const n=turn.swallow?4:P.die;if(die.n!==n)dieSet(die,n);G.phase='sweep';dieToss(die);roundFx(isHot(h),false);
    if(G.auto){const pref={attack:['shield','sword'],block:['skull','sword','heart'],dodge:['sword','heart'],stun:['sword']}[E.intent];let t=-1; // the demo: aims at what answers the intent, now and then fumbles or lets the bar run out
      for(const k of pref){t=G.slots.findIndex(q=>q.k===k);if(t>=0)break}if(t<0)t=G.slots.findIndex(q=>q.k!=='bomb');if(P.hp<=3){const h=G.slots.findIndex(q=>q.k==='heart');if(h>=0)t=h}
      const r=Math.random();G.autoT=t;G.autoMode=r<.08?'':r<.16?'early':'aim'}}
  /* a new bar on this screen: the slots get what the drawing needs (a centre, a pop), the sweep starts over */
  function setBar(bar){G.bar={...bar,slots:viewSlots(bar.slots)};G.slots=G.bar.slots;G.cursor=0;G.pressed=false;G.hitSlot=-1;G.lastSlot=-1;G.picks=[];G.firstSlot=-1;G.blank=false}
  function sweepTick(){const g=gradeAt(G.bar,G.cursor,1).slot;if(g!==G.lastSlot){G.lastSlot=g;if(g>=0)SFX.tick()}} // a tick as the cursor comes onto a slot
  /* the top of a round, both modes: who is hot (a second die, a fifth up, a word about it), and a tip for anything new on the bar */
  function roundFx(mine,theirs,two2=false){P.hot=mine;E.hot=theirs;G.pitch=mine?1.5:1;tossHot(die,dieB,mine||G.bar.presses===2,-1);tossHot(die2,die2B,theirs||two2,1);
    if(mine){banner(T('fever'),T('feverSub'));SFX.fever();G.flashBG=1}if(theirs)word(E,T('fever'),'#d0521f',34);tips()}
  function advance(){if(P.hp<=0){startDeath();return}
    if(E.hp<=0&&G.phase!=='ko'){G.phase='ko';G.pt=1;E.pose='ko';E.poseT=9;E.leanV-=6;word(E,T('ko'),RED,40);SFX.ko();setPose(P,'cheer',.8);G.kills++;addScore(500*(G.stage+1));addXP(8+G.stage*2);return}
    if(G.pendingLvl>0){openPerks();return}
    newRound()}
  function openPerks(){G.pendingLvl--;G.state=G.auto?'title':'perk';G.phase='perk';G.perkT=0;G.perkPicked=-1;const pool=dealPerks(SOLO.rnd,SOLO.hero,G);
    if(SOLO.feat.faces&&SOLO.rnd()<.6){const c=dealFaces(SOLO.rnd,SOLO.hero,P.die,1)[0];if(c)pool[ri(0,pool.length-1)]=faceCard(c)} // a level up may offer a face to load
    const di=DIE_STEPS.indexOf(P.die);if(di<DIE_STEPS.length-1&&G.lvl%2===0){BIGDIE.vars={n:DIE_STEPS[di+1],a:P.die,b:DIE_STEPS[di+1]};pool[ri(0,2)]=BIGDIE}
    G.perks=pool;SFX.level();banner(T('levelUp'),T('lv',{n:G.lvl}));setPose(P,'cheer',.9);heartsFx(P.x,GROUND-200,0)}
  function pickPerk(i){if(G.perkPicked>=0)return;G.perkPicked=i;G.pt=.45;const p=G.perks[i];p.f(SOLO.hero,G);syncSolo();SFX.pickp();P.hpPop=1;word(P,T(p.nk||'perk.'+p.id,p.vars),'#8a6a10',24)}
  function startDeath(){G.phase='dying';G.pt=1.3;P.pose='ko';P.poseT=9;P.leanV-=6;word(P,T('ko'),RED,40);SFX.dead();G.shake=18;
    if(!G.auto&&G.score>G.best){G.best=G.score;try{localStorage.setItem('loadedDiceBest',G.best)}catch(e){}}}

  /* ---------- input: one button. Space / Enter / Z / X, a click, or a tap anywhere on the canvas (the press is taken on pointerdown,
     not on click, so a finger costs no more than a key). px / py are in the design space; only the perk cards read them. */
  const overlayOpen=()=>dom.pause.classList.contains('show')||dom.help.classList.contains('show');
  function press(px,py){audio.init();if(!session||overlayOpen())return;
    if(V.on){if(G.phase==='draft')draftPress(px,py);else if(G.phase==='sweep'&&!G.pressed)duelPress(true);return}
    if(G.state==='title'){resetRun(false);SFX.pickp();return}
    if(G.state==='dead'){if(G.deadT>.7){resetRun(false);SFX.pickp()}return}
    if(G.state==='perk'){let i=Math.floor(G.perkT/.62)%3;if(px!=null){const z=compact?PERK_ZOOM:1,qx=640+(px-640)/z,qy=410+(py-410)/z;
      for(let k=0;k<3;k++){const x=640+(k-1)*250;if(Math.abs(qx-x)<112&&qy>290&&qy<530)i=k}}pickPerk(i);return}
    if(G.state==='play'&&G.phase==='sweep'&&!G.pressed)doPress(true)}
  const canRun=()=>!online||isHost; // R and Esc are the host's, as in every game here
  const kb=createInput({Space:'go',Enter:'go',KeyZ:'go',KeyX:'go',KeyM:'mute',KeyL:'lang',KeyR:'again',Escape:'exit'},{onDown:name=>{
    if(name==='go')press();else if(name==='mute')audio.toggle();else if(name==='lang'){nextLang();if(dom.pause.classList.contains('show'))renderMenu();if(dom.help.classList.contains('show'))showHelp(true)}
    else if(name==='again'){if(canRun())hooks.onRestart?.()}
    else if(overlayOpen()){showMenu(false);showHelp(false)}else if(canRun())hooks.onExit?.()}});
  cv.addEventListener('pointerdown',e=>{e.preventDefault();const r=cv.getBoundingClientRect();press(((e.clientX-r.left)*DPR-OX)/SC,((e.clientY-r.top)*DPR-OY)/SC)});
  /* iOS Safari: no loupe, no callout and no scroll bounce from a finger resting on the canvas, no pinch zoom in a browser tab */
  cv.addEventListener('touchstart',e=>e.preventDefault(),{passive:false});
  cv.addEventListener('contextmenu',e=>e.preventDefault());
  root.addEventListener('gesturestart',e=>e.preventDefault());

  /* what the press was, said over the bar at once (both modes). G.grade is a code ('PERFECT', 'GOOD', 'MISSED', 'plain', 'late'), drawn as strings.js's 'grade.<code>' */
  function showGrade(pk,slot,combo,lost){const perfect=pk.grade==='PERFECT';G.gradeT=0;
    if(pk.grade==='MISSED'){G.grade='MISSED';G.gradeSub=lost>1?T('sub.lost',{n:lost}):T('sub.fumble');G.gradeCol=RED;SFX.miss();G.barShake=1;setPose(P,'miss',.5)}
    else if(pk.grade&&slot.k==='bomb'){slot.pop=1;G.grade='bomb';G.gradeSub=lost>1?T('sub.lost',{n:lost}):T('sub.bomb');G.gradeCol=RED;G.barShake=1}
    else if(pk.grade){const jp=slot.k==='jackpot',act=T('act.'+(slot.k==='fast'&&MODS().fastSelf?'fastSelf':slot.k)),n=(jp?3:perfect?2:1)+MODS().rigPlus;slot.pop=1;G.grade=jp?'jackpot':pk.grade;G.gradeCol=perfect||jp?'#8a6a10':INK;
      G.gradeSub=combo?T('sub.rigCombo',{act,n,c:combo}):T('sub.rig',{act,n});perfect||jp?SFX.perfect(combo||(P.combo|0)+1):SFX.good();if(perfect||jp)G.flashBG=1}
    else{G.grade='plain';G.gradeSub=T('sub.plain');G.gradeCol='#7d786c';SFX.plain()}}
  /* A press on this screen's bar (both modes). A double round's first crossing takes one press and the sweep goes on; returns
     { pk, done }: what it picked, and whether the round's presses are all in (G.picks). */
  function takePress(real){const two=G.bar.presses===2,u=real?G.cursor:-1;let pk=gradeAt(G.bar,u,perfNow());
    if(two&&!G.picks.length&&real&&G.cursor<1){G.picks.push(u);G.firstSlot=pk.slot;if(pk.slot>=0)G.slots[pk.slot].used=1;return{pk,done:false}}
    if(two&&!G.picks.length)G.picks.push(-1); // the first crossing went by
    if(two&&pk.slot>=0&&pk.slot===G.firstSlot)pk={slot:-1,grade:'MISSED'}; // the same slot twice
    G.picks.push(u);G.pressed=true;G.pressU=G.cursor;G.hitSlot=pk.slot;return{pk,done:true}}
  /* the solo press: when the presses are in the whole round is played by the rules at once, so the dice can land on their numbers; the screen catches up when they have */
  function doPress(real){const h=SOLO.hero,F=SOLO.foe,lost=h.combo,first=G.picks.length?1:0,{pk,done}=takePress(SOLO.turn.swallow?false:real),rigged=(pk.grade==='PERFECT'||pk.grade==='GOOD')&&G.slots[pk.slot].k!=='bomb';
    showGrade(pk,G.slots[pk.slot],rigged?lost+1+first:0,lost);if(rigged){addScore(pk.grade==='PERFECT'?20:10);G.maxCombo=Math.max(G.maxCombo,lost+1+first)}if(!done)return;
    const R=SOLO.R=playRound(SOLO.rnd,[h,F.f],[die.n,F.die],[G.bar,[]],[G.bar.presses===2?G.picks:G.picks[0],SOLO.turn.picks],SOLO.feat),me=R.r[0];
    for(const r of[me,R.r2[0]])if(r&&r.slot>=0&&!r.jackpot&&G.slots[r.slot])G.slots[r.slot].k=r.act; // a mystery slot shows what it was
    G.phase='roll';slamSecond(dieB,me,R.r2[0]);dieSlam(die,faceOf(me),me.crit,soloResolve)}
  const faceOf=r=>clamp(r.roll||r.base||1,1,99); // a bomb rolls nothing: the die lies as it was thrown
  /* the second die: a double round's second move, or the throw a hot round did not keep; it fades once it is down */
  function slamSecond(b,r,r2){if(b.live)dieSlam(b,clamp(r2?faceOf(r2):r.other+r.bonus,1,b.n),!!(r2&&r2.crit),()=>{b.fade=!r2})}

  function dmgTxt(d){return'-'+(d>=2?Math.floor(d/2):'')+(d%2?'½':'')}
  function hurt(f,d,crit,from){f.hp=Math.max(0,f.hp-d);f.flash=1;f.shake=1;f.hpPop=1;setPose(f,'hurt',.5);f.oxV-=300;word(f,dmgTxt(d)+' ♥',RED,26);
    burst(f.x-f.face*20,GROUND-130*f.scale,crit?120:84,crit?'#f08a4b':YEL);sparks(f.x,GROUND-130*f.scale,crit?16:8,INK);
    if(from)slash(from.x+from.face*90,f.x-f.face*50,GROUND-120,crit?'#f08a4b':INK);
    G.hitStop=Math.max(G.hitStop,crit?.13:.07);G.shake=Math.max(G.shake,crit?20:11);crit?SFX.crit():SFX.hit()}
  /* the dice are down: a round's outcome (rules.js's { r, out }) turned into this screen's words, poses, particles and sounds. Side i is fOf(i). */
  function showOutcome(R){let clashed=false;const r2s=R.r2||[null,null];
    for(let i=0;i<2;i++){const f=fOf(i),foe=fOf(1-i),o=R.out[i],r=R.r[i],d=dOf(i);f.rolled=r.roll;
      [r,r2s[i]].forEach((q,k)=>{if(q&&q.bonus&&q.grade&&q.act!=='miss')words.push({f:null,text:q.lucky?T('lucky'):T('rigged',{base:q.base,bonus:q.bonus}),col:'#8a6a10',size:20,x:(k?(i===V.me?dieB:die2B):d).x,y:DIE_GY-170,t:0,T:.8})});
      for(const[key,tone]of o.say)word(f,T(key),TONES[tone]||INK,tone==='hot'?38:30);
      if(o.pose)setPose(f,o.pose,.55);
      for(const fxn of[o.fx,o.fx2])playFx(fxn);
      function playFx(name){const o={fx:name,heal:R.out[i].heal};
      if(o.fx==='block'){ring(f.x+f.face*60,GROUND-120,70);SFX.block();f.sy=.9;G.shake=Math.max(G.shake,6);slash(foe.x+foe.face*90,f.x+f.face*80,GROUND-120,INK)}
      else if(o.fx==='clash'){if(!clashed){clashed=true;burst(640,GROUND-150,90,'#fff');sparks(640,GROUND-150,14,INK);SFX.clash();G.shake=Math.max(G.shake,10);G.hitStop=.06}}
      else if(o.fx==='spook'){SFX.spook();if(!R.out[1-i].dmg){foe.shake=.8;foe.flash=.6}}
      else if(o.fx==='heal'){heartsFx(f.x,GROUND-170,o.heal>1?9:5,RED);SFX.heal();f.hpPop=1}
      else if(o.fx==='up')SFX.up();else if(o.fx==='down')SFX.down();else if(o.fx==='whiff')SFX.dodge();
      else if(o.fx==='ink'){SFX.ink();for(let k=0;k<14;k++)parts.push({k:'puff',x:foe.x+rnd(-60,60),y:GROUND-rnd(150,260)*foe.scale,vx:rnd(-40,40),vy:-rnd(10,60),r:rnd(12,22),t:0,T:rnd(.5,.9),ink:1})}
      else if(o.fx==='boom'){burst(f.x,GROUND-130*f.scale,120,'#3a3630');sparks(f.x,GROUND-130*f.scale,18,'#f08a4b');dust(f.x,GROUND,10,1.4);SFX.boom();G.shake=Math.max(G.shake,16)}}
      if((r.jackpot||r2s[i]&&r2s[i].jackpot)&&o.won){G.flashBG=2.5;ring(d.x,DIE_GY-60,130);sparks(d.x,DIE_GY-60,26,'#e0a93c');SFX.jackpot()}
      if(o.fx==='venom'||o.fx2==='venom'){SFX.venom();for(let k=0;k<10;k++)parts.push({k:'heart',x:foe.x+rnd(-40,40),y:GROUND-rnd(100,220)*foe.scale,vx:rnd(-30,30),vy:-rnd(30,90),r:rnd(5,9),t:0,T:rnd(.6,1),col:'#8fbf5a'})}
      if(o.face){words.push({f:null,text:T('face.'+o.face),col:'#7a5a9a',size:22,x:d.x,y:DIE_GY-200,t:0,T:1});ring(d.x,DIE_GY-60,90);SFX.carve()}
      if(o.tick){word(f,dmgTxt(o.tick)+' ♥','#4f8a3c',24);f.hpPop=1;f.flash=.4}
      if(o.heal&&o.fx!=='heal'&&o.fx2!=='heal'){heartsFx(f.x,GROUND-170,3,RED);f.hpPop=1}} // a vampire's crit
    for(let i=0;i<2;i++){const o=R.out[i];if(o.dmg)hurt(fOf(i),o.dmg,o.hitCrit,(o.fx==='boom'||o.fx2==='boom')&&!R.out[1-i].won?null:fOf(1-i))}} // a bomb is nobody's swing
  function soloResolve(){const R=SOLO.R,me=R.r[0],foe=R.r[1],o=R.out[0],fo=R.out[1];E.hidden=false;
    if(foe.act!=='stun'&&foe.act!=='none')chip(E.x-100*E.scale,GROUND-250*E.scale,foe.roll,foe.crit);if(R.r2[1])chip(E.x-150*E.scale,GROUND-215*E.scale,R.r2[1].roll,R.r2[1].crit); // a flurry shows both
    showOutcome(R);syncSolo();
    if(o.fx==='block'){addScore(60);addXP(2)}if(me.act==='skull'&&me.ok){addScore(40);addXP(2)}if(me.act==='heart'&&me.ok)addXP(1);if(me.act==='fast'){addScore(80);addXP(2)}
    if(fo.dmg){addScore(fo.hitCrit?250:100);addXP(fo.hitCrit?5:3)}
    G.phase='resolve';G.pt=clamp(.62/Math.sqrt(speed()),.36,.62)+(o.dmg||fo.dmg?.08:0)}

  /* ---------- update ---------- */
  function update(dt,rdt){G.t+=dt;if(V.on)updateDuel(dt);const sp=G.phase==='sweep'||G.phase==='roll'||G.phase==='resolve'?pressure():1;
    if(V.on){}
    else if(G.phase==='intro'){G.pt-=dt;E.homeX=1050;if(E.x>1056)E.oy=-Math.abs(Math.sin(G.t*14))*18;if(G.pt<=0){E.oy=0;advance()}}
    else if(G.phase==='sweep'){G.cursor+=dt*pressure()/SWEEP_T;sweepTick();const end=spanOf(G.bar),g=G.auto?gradeAt(G.bar,G.cursor,perfNow()):null;
      if(g&&(G.autoMode==='early'?G.cursor>.2:G.autoMode==='aim'&&g.slot===G.autoT&&(g.grade==='PERFECT'||Math.random()<dt*5)))doPress(true);else if(G.cursor>=end){G.cursor=end;doPress(false)}}
    else if(G.phase==='resolve'){G.pt-=dt;if(G.pt<=0)advance()}
    else if(G.phase==='ko'){G.pt-=dt;E.alpha=clamp(G.pt*2.2,0,1);if(G.pt<=0){G.stage++;spawnEnemy()}}
    else if(G.phase==='perk'){G.perkT+=dt;if(G.auto&&G.perkT>1.1&&G.perkPicked<0)pickPerk(ri(0,2));
      if(G.perkPicked>=0){G.pt-=dt;if(G.pt<=0){G.state=G.auto?'title':'play';G.phase='resolve';G.pt=0;advance()}}}
    else if(G.phase==='dying'){G.pt-=dt;if(G.pt<=0){if(G.auto)resetRun(true);else{G.state='dead';G.phase='dead';G.deadT=0}}}
    if(G.state==='dead'){G.deadT+=rdt;if(G.deadT>14)resetRun(true)}
    die2.live=V.on;for(const d of DICE)if(d.live)dieUpdate(d,dt,sp);
    if(G.phase==='sweep'||G.phase==='roll')for(const f of[P,E])if(f.hot&&Math.random()<dt*40)parts.push({k:'spark',x:f.x+rnd(-50,50),y:GROUND+rnd(-6,6),vx:rnd(-30,30),vy:-rnd(140,320),r:rnd(2.5,4.5),t:0,T:rnd(.35,.6),col:Math.random()<.5?'#f08a4b':'#ffcd46'});
    updFighter(P,dt,G.t,sp);updFighter(E,dt,G.t,sp);
    for(const s of G.slots)s.pop=Math.max(0,s.pop-dt*3.5)}
  function updateFx(dt){G.gradeT+=dt;G.shake=Math.max(0,G.shake-dt*60);G.barShake=Math.max(0,G.barShake-dt*4);G.flashBG=Math.max(0,G.flashBG-dt*5);
    for(let i=parts.length-1;i>=0;i--){const p=parts[i];p.t+=dt;if(p.t>=p.T){parts.splice(i,1);continue}p.x+=p.vx*dt;p.y+=p.vy*dt;
      if(p.k==='puff'){p.vx*=1-dt*4;p.vy*=1-dt*4}else if(p.k==='peb'){p.vy+=900*dt;if(p.y>p.gy){p.y=p.gy;p.vy*=-.4}}else if(p.k==='spark'){p.vx*=1-dt*5;p.vy*=1-dt*5}else if(p.k==='heart')p.vy*=1-dt*1.5}
    for(let i=fx.length-1;i>=0;i--){fx[i].t+=dt;if(fx[i].t>=fx[i].T)fx.splice(i,1)}
    for(let i=words.length-1;i>=0;i--){words[i].t+=dt;if(words[i].t>=words[i].T)words.splice(i,1)}}

  /* ---------- render ---------- */
  function drawParts(){for(const p of parts){const u=p.t/p.T;
    if(p.k==='puff'){ctx.globalAlpha=(1-u)*.9;shape(p.ink?'#3a3448':'#dcd6c6',()=>ell(p.x,p.y,p.r*(.6+u),p.r*(.6+u)*.8),0);ctx.lineWidth=2;ctx.strokeStyle='#b5ae9c';ctx.stroke()}
    else if(p.k==='peb'){ctx.globalAlpha=1-u;shape('#b5ae9c',()=>ell(p.x,p.y,p.r,p.r),0)}
    else if(p.k==='spark'){ctx.globalAlpha=1-u;line(p.x,p.y,p.x-p.vx*.03,p.y-p.vy*.03,p.r,p.col)}
    else if(p.k==='heart'){ctx.globalAlpha=1-u*u;shape(p.col,()=>heartPath(p.x,p.y,p.r),3)}}ctx.globalAlpha=1}
  function drawFx(){for(const f of fx){const u=f.t/f.T;
    if(f.k==='burst'){const s=f.r*(u<.35?lerp(.3,1,u/.35):1+(u-.35)*.2);ctx.save();ctx.translate(f.x,f.y);ctx.rotate(f.rot);ctx.globalAlpha=u>.7?(1-u)/.3:1;
      shape(f.col,()=>poly(f.sp.map((r,i)=>{const a=i*TAU/20;return[Math.cos(a)*r*s,Math.sin(a)*r*s]})),5);ctx.restore()}
    else if(f.k==='ring'){ctx.globalAlpha=1-u;ctx.beginPath();ctx.arc(f.x,f.y,f.r*(.4+u),0,TAU);ctx.lineWidth=7*(1-u)+1;ctx.strokeStyle=INK;ctx.stroke();ctx.globalAlpha=1}
    else if(f.k==='slash'){const x=lerp(f.x0,f.x1,u),d=Math.sign(f.x1-f.x0);ctx.globalAlpha=.9;ctx.beginPath();ctx.moveTo(x,f.y-46);ctx.quadraticCurveTo(x+d*44,f.y,x,f.y+46);ctx.quadraticCurveTo(x+d*18,f.y,x,f.y-46);ctx.fillStyle=f.col;ctx.fill();
      ctx.globalAlpha=.25;ctx.fillRect(Math.min(f.x0,x),f.y-3,Math.abs(x-f.x0),6);ctx.globalAlpha=1}
    else if(f.k==='chip'){const s=u<.12?lerp(.3,1.2,u/.12):u<.2?lerp(1.2,1,(u-.12)/.08):1;ctx.save();ctx.translate(f.x,f.y-u*10);ctx.scale(s,s);ctx.rotate(-.12);ctx.globalAlpha=u>.8?(1-u)/.2:1;
      shape(f.crit?'#ffcd46':'#ece0b6',()=>rr(-22,-22,44,44,9),4.5);txt(''+f.num,0,11,30,{w:900});ctx.restore()}}}
  function drawWords(){for(const w of words){const u=w.t/w.T,s=u<.1?lerp(.4,1.25,u/.1):u<.18?lerp(1.25,1,(u-.1)/.08):1;ctx.save();ctx.translate(w.x,w.y-u*16);ctx.scale(s,s);ctx.globalAlpha=u>.75?(1-u)/.25:1;
    txt(w.text,0,0,w.size,{w:800,c:w.col,stroke:BG,sw:8,ls:1.5});if(w.sub)txt(w.sub,0,26,14,{w:700,c:'#6d685c',stroke:BG,sw:6,ls:2});ctx.restore()}}
  function drawHearts(cx,y,f){const n=Math.ceil(f.maxHp/2),gap=38,x0=cx-(n-1)*gap/2;for(let i=0;i<n;i++){const v=clamp(f.hp-i*2,0,2),x=x0+i*gap,pop=1+f.hpPop*.25*(i===Math.floor(Math.max(0,f.hp-1)/2)?1:.3);
    ctx.save();ctx.translate(x,y);ctx.scale(pop,pop);shape(v?'#f6f1e6':null,()=>heartPath(0,0,13),0);
    if(v){ctx.save();ctx.beginPath();heartPath(0,0,13);ctx.clip();ctx.fillStyle=f.poison>0?'#7fae4e':RED;ctx.fillRect(-22,-16,v===2?44:22,34);ctx.restore()}
    ctx.beginPath();heartPath(0,0,13);ctx.lineWidth=v?3.5:2.5;ctx.strokeStyle=v?INK:'#b9b3a6';ctx.lineJoin='round';ctx.stroke();ctx.restore()}}
  function drawFever(cx,y,f,on){if(!on)return;const w=96,h=7,x=cx-w/2,k=f.hot?1:clamp((f.fever||0)/FEVER_MAX,0,1),hotC=Math.sin(G.t*14)>0?'#ffcd46':'#f08a4b';
    shape('#ddd8c9',()=>rr(x,y,w,h,3.5),0);if(k>.02)shape(f.hot?hotC:k>=1?'#f08a4b':'#e0b53c',()=>rr(x,y,w*k,h,3.5),0);ctx.beginPath();rr(x,y,w,h,3.5);ctx.lineWidth=2;ctx.strokeStyle=INK;ctx.stroke();
    for(let i=1;i<FEVER_MAX;i++)line(x+w*i/FEVER_MAX,y+1,x+w*i/FEVER_MAX,y+h-1,1,'rgba(37,35,31,.35)');
    txt(T('feverCap'),x-6,y+7,8,{a:'right',ls:1,c:f.hot||k>=1?'#d0521f':'#6d685c'})}
  /* a fighter's face in a ring beside its hearts (a fighter that is a picture) */
  function portrait(f,cx,y,side){const A=artOf(f);if(!A)return;const im=A.idle.img,[u,v,r]=f.cfg.face,W=im.naturalWidth,H=im.naturalHeight,R=r*H,n=Math.ceil(f.maxHp/2),x=cx+side*((n-1)*19+50),pop=1+f.hpPop*.12;
    ctx.save();ctx.translate(x,y);ctx.scale(pop,pop);shape('#fbf8f0',()=>ell(0,0,24,24),0);ctx.save();ctx.beginPath();ell(0,0,24,24);ctx.clip();if(f.cfg.dir!==f.face)ctx.scale(-1,1);ctx.drawImage(im,u*W-R,v*H-R,2*R,2*R,-24,-24,48,48);
    if(f.hp<=0){ctx.globalAlpha=.55;ctx.fillStyle='#fbf8f0';ctx.fillRect(-24,-24,48,48)}ctx.restore();ctx.beginPath();ell(0,0,24,24);ctx.lineWidth=3.5;ctx.strokeStyle=f.hp>0&&f.hp<=2?RED:INK;ctx.stroke();ctx.restore()}
  function stat(label,val,x,y,sub,col){txt(label,x,y,9,{ls:1.5,c:'#6d685c'});txt(val,x,y+21,19,{w:700,c:col||INK});if(sub)txt(sub,x,y+36,8,{ls:1,c:'#6d685c'})}
  /* on a phone-sized view a block is drawn larger about its own centre (and nudged by dx); elsewhere it is drawn as it is */
  function zoom(cx,cy,k,fn,dx=0){if(!compact){fn();return}ctx.save();ctx.translate(cx+dx,cy);ctx.scale(k,k);ctx.translate(-cx,-cy);fn();ctx.restore()}
  function drawHUD(){if(V.on){drawDuelHUD();return}const sp=speed();
    zoom(228,105,1.3,()=>{drawHearts(228,105,P);portrait(P,228,97,-1);drawFever(228,122,P,SOLO.feat.fever);stat(T('score'),G.score.toLocaleString('en-US'),122,146);stat(T('combo'),''+P.combo,193,146);stat(T('die'),'D'+P.die,263,146,T('toHit',{n:P.toHit}));
    stat(T('speed'),sp.toFixed(2)+'×',335,146,null,sp>2.4?RED:sp>1.7?'#b0761a':INK);
    txt(T('lv',{n:G.lvl}),192,209,13,{a:'right',ls:1});shape('#ddd8c9',()=>rr(200,199,90,9,4.5),0);const xf=clamp(G.xp/G.need,0,1);if(xf>.02)shape('#e0b53c',()=>rr(200,199,90*xf,9,4.5),0);
    ctx.beginPath();rr(200,199,90,9,4.5);ctx.lineWidth=2;ctx.strokeStyle=INK;ctx.stroke()},-44);
    zoom(1050,105,1.3,()=>{drawHearts(1050,105,E);portrait(E,1050,97,1);stat(T('combo'),''+E.combo,970,146);stat(T('die'),'D'+E.die,1051,146,E.rolled?T('rolled',{r:E.rolled,n:E.toHit}):T('toHit',{n:E.toHit}));stat(T('speed'),eSpeed().toFixed(2)+'×',1135,146);
    txt(T('stageOf',{name:nameOf(E)+(E.tier?' +'+E.tier:''),n:G.stage+1}),1050,209,10,{ls:2,c:'#6d685c'})},44);
    // enemy intent bubble
    if((G.phase==='sweep'||G.phase==='roll')&&E.hp>0){const bx=E.x-(E.cfg.bub||96)*E.scale,by=GROUND-(E.cfg.wordY||250)*E.scale-4+Math.sin(G.t*6)*3,k=E.hidden?'mystery':E.intent;
      zoom(bx,by,1.25,()=>{bubble(bx,by);
      icon(k,bx,by,.95);txt(T('intent.'+(E.hidden?'hidden':E.intent)),bx,by+46,9,{ls:1.5,c:'#6d685c',stroke:BG,sw:4})})}
    drawBar()}
  function bubble(bx,by){shape('#fbf8f0',()=>{rr(bx-30,by-30,60,60,14)},4);shape('#fbf8f0',()=>poly([[bx+22,by+22],[bx+42,by+40],[bx+28,by+10]]),0);line(bx+24,by+29,bx+42,by+40,4);line(bx+42,by+40,bx+30,by+14,4)}
  const BX=455,BY=142,BW=370,BH=58;
  function drawBar(){zoom(640,BY+BH/2,1.4,drawBarIn)}
  function drawBarIn(){const m=MODS(),shk=G.barShake>0?Math.sin(G.t*90)*G.barShake*7:0;ctx.save();ctx.translate(shk,0);
    const u=G.pressed?G.pressU:G.cursor,now=slotsAt(G.bar,u),cur=cursorAt(G.bar,u),back=G.bar.v==='bounce'&&u>1,fog=G.bar.fog;
    txt(T('barRig',{g:1+m.rigPlus,p:2+m.rigPlus}),BX+1,BY-14,10,{a:'left',ls:1.5});txt(T('barSweep',{x:pressure().toFixed(2)})+(G.bar.presses===2?'  ·  '+T('act.double'):G.bar.v!=='still'?'  ·  '+T('act.'+G.bar.v):''),BX+BW-1,BY-14,10,{a:'right',ls:1.5,c:pressure()>2.4?RED:'#6d685c'});
    shape((G.grade==='MISSED'||G.grade==='bomb')&&G.gradeT<.5?'#ecd3cb':'#dbd8c8',()=>rr(BX,BY,BW,BH,9),4);
    if(P.hot){ctx.beginPath();rr(BX-4,BY-4,BW+8,BH+8,12);ctx.lineWidth=5;ctx.strokeStyle=Math.sin(G.t*14)>0?'#ffcd46':'#e0a93c';ctx.stroke()}
    if(fog){const fx=BX+fog[0]*BW,fw=(fog[1]-fog[0])*BW;ctx.save();ctx.beginPath();rr(BX+2,BY+2,BW-4,BH-4,7);ctx.clip();ctx.fillStyle='#3a3448';ctx.globalAlpha=G.pressed?.35:.9;ctx.fillRect(fx,BY,fw,BH);
      for(let k=0;k<9;k++){const e=k%2?fx:fx+fw,y=BY+BH*(k+.5)/9;ctx.beginPath();ell(e+Math.sin(G.t*2+k)*3,y,9+3*Math.sin(k*2.1),BH/9);ctx.fill()}ctx.restore()}
    G.slots.forEach((s,i)=>{const q=now[i];if(!G.pressed&&fogged(G.bar,q,cur))return;const bad=s.k==='skull'||s.k==='slow'||s.k==='smoke'||s.k==='poison',gold=s.k==='jackpot',bomb=s.k==='bomb',x=BX+q.x*BW,w=q.w*BW,dim=G.pressed&&G.hitSlot!==i&&!s.used,hit=G.hitSlot===i||!!s.used,sc=1+s.pop*.16,blank=G.blank&&!G.pressed&&!gold&&!bomb; // a faceless round: what a slot is shows once one is pressed (never the gold or the bomb)
      ctx.save();ctx.translate(x+w/2,BY+BH/2);ctx.scale(sc,sc);ctx.globalAlpha=dim?.4:1;
      shape(gold?`hsl(46,96%,${62+10*Math.sin(G.t*13)}%)`:bomb?'#57524a':hit?(G.grade==='PERFECT'?'#ffe066':'#d8e8a8'):blank?'#efe9d8':bad?SLOT_RED:GRN,()=>rr(-w/2,-BH/2+5,w,BH-10,Math.min(7,w/3)),3.5);
      const pw=w*perfNow();if(!hit&&!gold&&!bomb){ctx.fillStyle=blank?'#d6cfba':bad?'#c9584a':YEL;ctx.fillRect(-pw/2,-BH/2+7,pw,BH-14)}
      icon(blank?'mystery':s.k,0,0,Math.min(.9,(w-2)/28));ctx.restore()});
    // cursor
    if(G.phase==='sweep'||G.phase==='roll'||G.phase==='resolve'){const cx=BX+cur*BW,d=back?1:-1,tx=clamp(cx+d*60,BX+3,BX+BW-3);
      if(!G.pressed){const g=ctx.createLinearGradient(tx,0,cx,0);g.addColorStop(0,'rgba(37,35,31,0)');g.addColorStop(1,'rgba(37,35,31,.22)');ctx.fillStyle=g;ctx.fillRect(Math.min(tx,cx),BY+4,Math.abs(cx-tx),BH-8)}
      line(cx,BY-7,cx,BY+BH+7,5,G.pressed&&G.grade==='MISSED'?RED:INK);shape(G.pressed&&G.grade==='MISSED'?RED:INK,()=>poly([[cx-8,BY-15],[cx+8,BY-15],[cx,BY-4]]),0)}
    ctx.restore();
    if(!compact&&V.on){txt(T('hint.duel1'),BX+BW/2,BY+BH+20,8.5,{ls:1.2,c:'#6d685c'});txt(T('hint.duel2'),BX+BW/2,BY+BH+33,8.5,{ls:1.2,c:'#6d685c'})}
    else if(!compact)txt(T('hint.solo'),BX+BW/2,BY+BH+20,8.5,{ls:1.2,c:'#6d685c'});
    if(G.grade&&G.gradeT<1.1){const u=G.gradeT,s=u<.08?lerp(.5,1.3,u/.08):u<.16?lerp(1.3,1,(u-.08)/.08):1;ctx.save();ctx.translate(640,88);ctx.scale(s,s);ctx.globalAlpha=u>.85?(1.1-u)/.25:1;
      txt(T('grade.'+G.grade),0,0,24,{w:800,c:G.gradeCol,ls:2});txt(G.gradeSub,0,17,10,{ls:1.5,c:G.gradeCol===RED?RED:'#6d685c'});ctx.restore()}}
  /* a blurb on two lines: broken at a space in English, at any character in Chinese */
  function wrap2(s,maxW,size){ctx.font=`600 ${size}px ${HUDF}`;if(LS)ctx.letterSpacing='0px';if(ctx.measureText(s).width<=maxW)return[s,''];
    const cjk=lang==='zh',ws=cjk?[...s]:s.split(' '),sep=cjk?'':' ';let l1='';
    for(let i=0;i<ws.length;i++){const next=l1+(l1?sep:'')+ws[i];if(l1&&ctx.measureText(next).width>maxW)return[l1,ws.slice(i).join(sep)];l1=next}return[l1,'']}
  const PERK_ZOOM=1.3; // the cards are hit-tested through the same zoom in press()
  function drawPerks(){ctx.fillStyle='rgba(243,238,227,.82)';ctx.fillRect(-400,compact?190:232,W+800,H+400);zoom(640,410,PERK_ZOOM,drawPerksIn)}
  function drawPerksIn(){const D=G.phase==='draft'?V.draft:null,hi=D?(G.perkPicked>=0?G.perkPicked:draftLit()):G.perkPicked>=0?G.perkPicked:Math.floor(G.perkT/.62)%3;
    txt(D?T(D.turn===V.me||D.turn===-2?(touch?'draftTap':'draftPress'):D.turn<0?'draftDone':'draftTheirs',{name:nameOf(E),s:Math.max(0,Math.ceil(D.secs-D.t))}):T(touch?'perkTap':'perkPress'),640,268,13,{w:800,ls:3,c:INK});
    G.perks.forEach((p,i)=>{const gone=D&&D.taken.includes(i)&&G.perkPicked!==i,x=640+(i-1)*250,on=i===hi,y=410-(on?12:0)+(G.perkPicked===i?-10:0),ap=clamp(G.perkT*5-i*.5,0,1);ctx.save();ctx.translate(x,y+(1-ap)*40);ctx.globalAlpha=ap*(gone||G.perkPicked>=0&&!on?.3:1);ctx.rotate((i-1)*.02);
      shape('rgba(70,60,45,.14)',()=>rr(-104,-104+(on?20:10),220,228,16),0);shape(on?'#ffe68a':'#fbf8f0',()=>rr(-110,-114,220,228,16),on?6:4.5);
      icon(p.icon,0,-50,1.7);txt(T(p.nk||'perk.'+p.id,p.vars),0,22,21,{w:800,ls:1});const[l1,l2]=wrap2(T(p.dk||'perk.'+p.id+'.d',p.vars),190,13);
      txt(l1,0,50,13,{w:600,c:'#57534a'});if(l2)txt(l2,0,68,13,{w:600,c:'#57534a'});if(on)txt('▲',0,100,14,{c:INK});ctx.restore()})}
  function drawTitle(){zoom(680,665,1.3,drawTitleIn)}
  function drawTitleIn(){const b=Math.sin(G.t*5)>-.3;ctx.save();ctx.translate(500,668);ctx.rotate(-.025);txt(T('title'),0,0,54,{w:900,stroke:BG,sw:12,ls:3});ctx.restore();
    txt(T('tagline'),500,692,10,{ls:3,c:'#57534a',stroke:BG,sw:5});
    shape(b?YEL:'#fbf8f0',()=>rr(716,632,250,42,21),4.5);txt(T(touch?'startTap':'startPress'),841,659,15,{w:800,ls:2.2});
    txt(T('demo')+(G.best?'  ·  '+T('best',{n:G.best.toLocaleString('en-US')}):''),841,692,9,{ls:2,c:'#8a8578'})}
  function drawDead(){const u=clamp(G.deadT*3,0,1);ctx.fillStyle=`rgba(243,238,227,${.8*u})`;ctx.fillRect(-400,-400,W+800,H+800);zoom(640,400,1.3,()=>drawDeadIn(u))}
  function drawDeadIn(u){ctx.save();ctx.translate(640,300-(1-u)*30);ctx.globalAlpha=u;ctx.rotate(-.025);
    txt(T('snakeEyes'),0,0,84,{w:900,c:RED,stroke:INK,sw:0,ls:4});ctx.restore();ctx.globalAlpha=u;
    txt(T('wentDown',{name:nameOf(P),n:G.stage+1}),640,344,13,{ls:3,c:'#57534a'});
    const st=[[T('score'),G.score.toLocaleString('en-US')],[T('bestCap'),G.best.toLocaleString('en-US')],[T('level'),''+G.lvl],[T('kills'),''+G.kills],[T('maxCombo'),''+G.maxCombo]];
    st.forEach((s,i)=>{const x=640+(i-2)*120;txt(s[0],x,400,10,{ls:2,c:'#6d685c'});txt(s[1],x,430,26,{w:800})});
    if(G.score>=G.best&&G.score>0)txt(T('newBest'),640,470,16,{w:800,c:'#8a6a10',ls:3});
    if(G.deadT>.7&&Math.sin(G.t*5)>-.3){shape(YEL,()=>rr(500,520,280,44,22),4.5);txt(T(touch?'againTap':'againPress'),640,548,16,{w:800,ls:2.5})}ctx.globalAlpha=1}
  function render(){ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle=BG;ctx.fillRect(0,0,cv.width,cv.height);
    const sh=G.shake;ctx.setTransform(SC,0,0,SC,OX+(sh?rnd(-1,1)*sh*SC*.6:0),OY+(sh?rnd(-1,1)*sh*SC*.6:0));
    if(G.flashBG>0){ctx.fillStyle=`rgba(255,224,102,${Math.min(.4,G.flashBG*.12)})`;ctx.fillRect(-400,-400,W+800,H+800)}
    if((P.hot||E.hot)&&(G.phase==='sweep'||G.phase==='roll'||G.phase==='resolve')){ctx.fillStyle=`rgba(255,140,40,${.07+.025*Math.sin(G.t*9)})`;ctx.fillRect(-400,-400,W+800,H+800)}
    // faint ground scuffs
    ctx.strokeStyle='rgba(70,60,45,.10)';ctx.lineWidth=3;ctx.lineCap='round';for(const[x,y,w]of[[380,GROUND+30,50],[860,GROUND+22,36],[560,GROUND+52,28],[740,GROUND+44,60],[120,GROUND+40,40],[1150,GROUND+44,44]]){ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+w,y);ctx.stroke()}
    drawFighterShadow(P);drawFighterShadow(E);for(const d of DICE)if(d.live)drawDieShadow(d);
    drawFighter(P,G.t);drawFighter(E,G.t);drawParts();for(const d of DICE)if(d.live)drawDie(d);drawFx();drawWords();drawHUD();
    if(G.phase==='perk'&&!G.auto||G.phase==='draft')drawPerks();
    if(G.state==='title')drawTitle();if(G.state==='dead')drawDead();
    if((G.state==='play'||V.on)&&!compact)txt(touch?T('foot.touch'):T('foot.keys',{mute:T(audio.muted?'foot.muted':'foot.mute')})+(!online||isHost?T('foot.host',{again:T(V.on?'foot.again':'foot.restart'),exit:T(online?'foot.lobby':'foot.quit')}):''),640,706,9,{ls:2,c:'#a19b8d'})}

  /* ---------- the duel: this screen's side of it ---------- */
  /* who a player is on the paper: the avatar picks the head, the body and the weapon, and its colour is the tunic's */
  const LOOKS=[['helm','bell','sword','#efe6cf'],['cyclops','round','club','#9a78c9'],['robot','box','wrench','#6c8494'],['goblin','bell','dagger','#8fbf5a'],
    ['toad','round','scepter','#6fae7a'],['pumpkin','round','scythe','#efe6cf'],['crow','bell','staff','#f2b632'],['helm','box','staff','#efe6cf']];
  function lookOf(p){const a=AVATARS[p.avatar]?p.avatar:0,[head,body,weapon,glove]=LOOKS[a],col=hex(AVATARS[a].color);
    return{name:String(p.name||T('player')).toUpperCase(),head,body,col,plume:col,trim:a===2?'#efe6cf':YEL,glove,weapon,scale:1}}
  const TONES={green:'#4f8a3c',ink:INK,dim:'#7d786c',red:RED,hot:'#d0521f',gold:'#8a6a10',purple:'#7a5a9a',blue:'#3f6f8a'};
  const fOf=i=>i===V.me?P:E,dOf=i=>i===V.me?die:die2;
  const viewSlots=slots=>(Array.isArray(slots)?slots:[]).map(s=>({k:s.k,x:s.x,w:s.w,c:s.x+s.w/2,pop:0}));
  function duelFighters(){const ps=session.players,hp=(session.opts.hearts||5)*2;P=mkFighter(lookOf(ps[V.me]),230,1);E=mkFighter(lookOf(ps[1-V.me]),1050,-1);
    for(const f of[P,E]){f.hp=f.maxHp=hp;f.toHit=TO_HIT;f.sp=1;f.wins=0;f.rolled=0}}
  function duelStart(s){V.on=true;V.m=s.seed>>>0;V.me=Math.max(0,s.players.slice(0,2).findIndex(p=>p.id===s.myId));V.target=s.opts.wins||2;
    V.d=1;V.n=0;V.rn=0;V.res=null;V.over=false;V.draft=null;V.oppSlots=[];V.oppLocked=false;V.oppHit=-1;V.oppAct='';V.helloT=0;
    Object.assign(G,{auto:false,state:'duel',phase:'wait',bar:{v:'still',slots:[]},slots:[],grade:'',gradeT:9,pressed:false,hitSlot:-1,cursor:0});
    duelFighters();E.x=1400;E.landed=0;die.home=520;die2.home=760;die.jit=die2.jit=20;die.x=die.x1=520;die2.x=die2.x1=760;
    const d0=dieForRound(1,s.opts.dice);dieSet(die,d0);dieSet(die2,d0);P.die=E.die=d0;
    banner(T('getReady'),T('vs',{a:nameOf(P),b:nameOf(E),n:V.target}));if(isHost)hostStart(s)}
  function onRound(msg){const mine=msg.f[V.me],theirs=msg.f[1-V.me];if(!mine||!theirs||!mine.bar||!Array.isArray(mine.bar.slots)||!Array.isArray(theirs.shown))return;const first=msg.rn===1;if(first&&V.n>0){const w=[P.wins,E.wins];duelFighters();P.wins=w[0];E.wins=w[1]}
    V.n=msg.n;V.d=msg.d;V.rn=msg.rn;V.res=null;V.oppLocked=false;V.oppHit=-1;V.oppAct='';
    if(first)banner(T('duelN',{n:msg.d}),T('duelSub',{die:msg.die,hit:TO_HIT,n:V.target}));else if(msg.die!==P.die){banner(T('bigger'),T('biggerSub',{a:P.die,b:msg.die}));SFX.level()}
    if(msg.die!==die.n){dieSet(die,msg.die);dieSet(die2,msg.die)}
    V.fever=!!msg.fever;for(let i=0;i<2;i++){const f=fOf(i),s=msg.f[i];f.hp=s.hp;f.combo=s.combo;f.sp=s.sp;f.fever=s.fever|0;f.poison=s.poison|0;f.faces=s.faces&&typeof s.faces==='object'?s.faces:{};dOf(i).faces=(i===V.me?dieB:die2B).faces=f.faces;f.die=msg.die;f.wins=msg.w[i];f.stun=!!s.dazed;f.rolled=0;
      if(f.stun){f.pose='daze';f.poseT=0}else if(f.pose==='daze')f.pose='idle'}
    setBar(mine.bar);V.oppSlots=viewSlots(theirs.shown);G.phase='sweep';dieToss(die);dieToss(die2);roundFx(!!mine.hot,!!theirs.hot,!!theirs.two)}
  /* my press (or my bar running out): graded here at once with the host's own function, rolled by the host when both sides are in */
  function duelPress(real){const{pk,done}=takePress(real);showGrade(pk,G.slots[pk.slot],0,0);if(!done)return;
    const two=G.bar.presses===2,u=G.picks[0],u2=two?G.picks[1]:-1;if(isHost)hostPick(V.me,two?[u,u2]:u);else send({t:'pick',m:V.m,n:V.n,u:+u.toFixed(4),u2:+u2.toFixed(4)})}
  function onResult(msg){if(msg.n!==V.n||V.res)return;V.res=msg;
    if(!G.pressed){G.pressed=true;G.pressU=G.cursor;G.hitSlot=-1;G.grade='late';G.gradeSub=T('sub.late');G.gradeCol='#7d786c';G.gradeT=0} // the host's deadline passed (this tab was hidden)
    const mine=msg.r[V.me],theirs=msg.r[1-V.me],r2=Array.isArray(msg.r2)?msg.r2:[null,null];for(const q of[mine,r2[V.me]])if(q&&q.slot>=0&&G.slots[q.slot]&&!q.jackpot)G.slots[q.slot].k=q.act; // a mystery slot shows what it was
    V.oppHit=theirs.slot<0?-1:V.oppSlots.findIndex(q=>Math.abs(q.x-theirs.sx)<1e-3);V.oppAct=theirs.act;V.oppLocked=true;V.landed=0;G.phase='roll'; // oppHit by its place: their bar may have been shown with a fake in it
    for(let i=0;i<2;i++){slamSecond(i===V.me?dieB:die2B,msg.r[i],r2[i]);dieSlam(dOf(i),Math.min(dOf(i).n,faceOf(msg.r[i])),msg.r[i].crit,()=>{if(++V.landed===2)duelResolve()})}}
  /* both dice are down: every screen turns the host's outcome into its own words, poses, particles and sounds */
  function duelResolve(){const R=V.res;showOutcome(R);
    for(let i=0;i<2;i++){const f=fOf(i),s=R.f[i];f.hp=s.hp;f.combo=s.combo;f.sp=s.sp;f.fever=s.fever|0;f.poison=s.poison|0;f.wins=s.wins;f.stun=!!s.dazed}
    G.phase='resolve';G.pt=.8}
  /* the cards between duels: the perk cards' look. On my turn the light walks the cards that are left and a press (or a tap on one) takes it */
  function onDraft(msg){const was=V.draft;V.draft={turn:msg.turn,taken:msg.taken,secs:msg.secs||8};G.phase='draft';G.perkPicked=-1;
    if(!was||was.n!==msg.n){V.draft.n=msg.n;G.perks=msg.cards.map(faceCard);G.perkT=0;SFX.level()}else{V.draft.n=msg.n;SFX.pickp()}V.draft.t=0}
  function draftPress(px,py){const D=V.draft;if(!D||D.turn!==V.me)return;let i=draftLit();if(px!=null){const z=compact?PERK_ZOOM:1,qx=640+(px-640)/z,qy=410+(py-410)/z;for(let k=0;k<3;k++)if(Math.abs(qx-(640+(k-1)*250))<112&&qy>290&&qy<530)i=k}
    if(i<0||D.taken.includes(i))return;D.turn=-2;G.perkPicked=i;SFX.carve();if(isHost)hostDrafted(V.me,i);else send({t:'drafted',m:V.m,i})}
  const draftLit=()=>{const D=V.draft,left=G.perks.map((c,i)=>i).filter(i=>!D.taken.includes(i));return D.turn===V.me&&left.length?left[Math.floor(G.perkT/.62)%left.length]:-1};
  function duelKo(){const R=V.res,down=R.win===-1?[0,1]:[1-R.win];G.phase='ko';G.pt=2.2;
    for(const i of down){const f=fOf(i);f.pose='ko';f.poseT=9;f.leanV-=6;word(f,T('ko'),RED,40)}
    if(R.win>=0)setPose(fOf(R.win),'cheer',1.4);R.win===V.me?SFX.level():SFX.ko();
    banner(R.win===-1?T('doubleKo'):R.win===V.me?T('youTake'):T('theyTake',{name:nameOf(E)}),T('tally',{a:nameOf(P),x:P.wins,y:E.wins,b:nameOf(E)}))}
  function updateDuel(dt){if(G.phase==='draft'){G.perkT+=dt;V.draft.t+=dt}
    if(G.phase==='wait'&&V.n===0&&!isHost){V.helloT-=dt;if(V.helloT<=0){V.helloT=.5;send({t:'hello',m:V.m})}} // until the first round comes: the host may have started a moment later than this machine
    if(G.phase==='sweep'&&!G.pressed){G.cursor+=dt*pressure()/SWEEP_T;sweepTick();const end=spanOf(G.bar);if(G.cursor>=end){G.cursor=end;duelPress(false)}}
    else if(G.phase==='resolve'){G.pt-=dt;if(G.pt<=0){if(V.res&&V.res.win!==null)duelKo();else G.phase='wait'}}
    else if(G.phase==='ko'){G.pt-=dt;if(G.pt<=0){if(V.res.over){G.phase='over';showResult(V.res)}else G.phase='wait'}}}
  function drawDuelPanel(f,cx,mine){drawHearts(cx,105,f);drawFever(cx,122,f,V.fever);const sp=f.sp||1;
    stat(T('wins'),(f.wins||0)+' / '+V.target,cx-105,146);stat(T('combo'),''+f.combo,cx-35,146);stat(T('die'),'D'+f.die,cx+35,146,f.rolled?T('rolled',{r:f.rolled,n:TO_HIT}):T('toHit',{n:TO_HIT}));
    stat(T('speed'),sp.toFixed(2)+'×',cx+105,146,null,sp>2.4?RED:sp>1.7?'#b0761a':INK);
    const nm=mine?T('you',{name:nameOf(f)}):nameOf(f);txt(f.stun?T('isDazed',{name:nm}):nm,cx,209,10,{ls:2,c:f.stun?'#7a5a9a':'#6d685c'})}
  /* the other side's bar, small: what they can pick this round is open, what they did pick is not until the dice are down */
  function drawOppBar(){const x0=945,y0=221,w=210,h=24;shape('#dbd8c8',()=>rr(x0,y0,w,h,6),3);
    V.oppSlots.forEach((s,i)=>{const bad=s.k==='skull'||s.k==='slow',hit=V.res&&V.oppHit===i,sw=s.w*w;ctx.globalAlpha=V.res&&!hit?.4:1;
      shape(hit?'#ffe066':s.k==='jackpot'?'#ffd84a':s.k==='bomb'?'#57524a':bad?SLOT_RED:GRN,()=>rr(x0+s.x*w,y0+3,sw,h-6,Math.min(4,sw/3)),2.5);icon(hit&&ICON[V.oppAct]&&s.k!=='jackpot'?V.oppAct:s.k,x0+s.c*w,y0+h/2,Math.min(.36,(sw-1)/34))});ctx.globalAlpha=1}
  function drawDuelHUD(){zoom(228,105,1.3,()=>drawDuelPanel(P,228,true),-44);zoom(1050,105,1.3,()=>{drawDuelPanel(E,1050,false);if(V.n)drawOppBar()},44);
    if((G.phase==='sweep'||G.phase==='roll'||G.phase==='resolve')&&E.hp>0){const bx=E.x-96,by=GROUND-254+Math.sin(G.t*6)*3,a=V.oppAct;
      zoom(bx,by,1.25,()=>{bubble(bx,by);
        if(V.res)icon(ICON[a]?a:a==='plain'?'sword':'stun',bx,by,.95);else if(V.oppLocked)icon('die',bx,by,.95);
        else for(let k=0;k<3;k++)shape(INK,()=>ell(bx-14+k*14,by-Math.max(0,Math.sin(G.t*7-k*.9))*7,4,4),0);
        txt(V.res?T('act.'+a):V.oppLocked?T('opp.locked'):T('opp.aiming'),bx,by+46,9,{ls:1.5,c:'#6d685c',stroke:BG,sw:4})})}
    drawBar()}

  /* ---------- the duel: the host's side. A state machine on the wall clock, stepped from the frame loop and, while this tab is hidden,
     from a worker timer, so the other player is not left waiting on a host who looked away. ---------- */
  const HS={feat:featsFor('classic'),bars:null,cards:[],taken:[],turn:0,lastWin:-1,phase:'idle',at:0,min:0,hello:false,rnd:null,fs:null,slots:null,pos:[null,null],n:0,rn:0,d:1,die:4};
  const cast=(msg,theirs,mine)=>{msg.m=V.m;send({...msg,...theirs});handle({...msg,...mine,from:hostId})}; // to the other player, and to this screen by the same road; what is for one of them only rides in `theirs` / `mine`
  function hostStart(s){const now=performance.now();HS.rnd=makeRng((s.seed^0x9e3779b9)>>>0).rnd;HS.fs=[0,1].map(()=>mkDuelist(s.opts.hearts||5));
    HS.n=0;HS.rn=0;HS.d=1;HS.hello=false;HS.pos=[null,null];HS.phase='hello';HS.min=now+1300;HS.at=now+6000}
  /* a round: each side gets its own bar whole, and the other side's only as the slots it is to see (now and then with a fake among them) */
  function hostRound(now){HS.n++;HS.rn++;HS.die=dieForRound(HS.rn,session.opts.dice);HS.feat=featsFor(session.opts.spice||'std',HS.d);
    const two=isDouble(HS.rnd,HS.feat)?{presses:2}:null;HS.bars=HS.fs.map(f=>mkBar(HS.rnd,genSlots(HS.rnd,f,HS.rn,null,HS.feat),HS.feat,f.fogged,two));HS.pos=[null,null];
    HS.phase='sweep';HS.at=now+SWEEP_T*Math.max(...HS.bars.map(spanOf))/Math.min(...HS.fs.map(speedOf))*1000+2500; // the slower bar, the toss and the link, with room to spare
    const seenBy=v=>HS.fs.map((f,i)=>({hp:f.hp,combo:f.combo,sp:+speedOf(f).toFixed(3),dazed:f.dazed,fever:f.fever,poison:f.poison,faces:f.mods.faces,hot:isHot(f),two:HS.bars[i].presses===2,bar:i===v?HS.bars[i]:null,shown:i===v?null:shownSlots(HS.rnd,HS.bars[i].slots,HS.feat)}));
    cast({t:'round',n:HS.n,rn:HS.rn,d:HS.d,die:HS.die,fever:HS.feat.fever,w:HS.fs.map(f=>f.wins)},{f:seenBy(1-V.me)},{f:seenBy(V.me)})}
  function hostPick(i,u){if(HS.phase!=='sweep'||HS.pos[i]!==null)return;HS.pos[i]=u;
    if(i===V.me)send({t:'locked',m:V.m,n:HS.n});else handle({t:'locked',m:V.m,n:HS.n,from:hostId});
    if(HS.pos[0]!==null&&HS.pos[1]!==null)hostResolve(performance.now())}
  function hostResolve(now){const res=playRound(HS.rnd,HS.fs,HS.die,HS.bars,HS.pos.map(p=>p===null?-1:p),HS.feat),over=res.win!==null&&res.win>=0&&HS.fs[res.win].wins>=V.target;
    HS.lastWin=res.win;HS.phase=res.win===null?'gap':over?'over':'ko';HS.at=now+(res.win===null?1500:3200);
    cast({t:'result',n:HS.n,r:res.r,r2:res.r2,out:res.out,win:res.win,over,f:HS.fs.map(f=>({hp:f.hp,combo:f.combo,sp:+speedOf(f).toFixed(3),dazed:f.dazed,fever:f.fever,poison:f.poison,wins:f.wins,perfects:f.perfects,crits:f.crits,dealt:f.dealt}))})}
  function hostTick(now){if(!session||!V.on||!isHost||V.over)return;
    if(HS.phase==='hello'){if((HS.hello&&now>=HS.min)||now>=HS.at)hostRound(now)}
    else if(HS.phase==='sweep'){if(now>=HS.at)hostResolve(now)}
    else if(HS.phase==='gap'){if(now>=HS.at)hostRound(now)}
    else if(HS.phase==='ko'&&now>=HS.at){if(HS.turn===-1){HS.turn=0;nextDuel(now)}else if(!hostDraft(now))nextDuel(now)}
    else if(HS.phase==='draft'&&now>=HS.at){const left=HS.cards.map((c,i)=>i).filter(i=>!HS.taken.includes(i));hostDrafted(HS.turn,left[Math.floor(Math.random()*left.length)])}} // too slow: a card at random
  function nextDuel(now){for(const f of HS.fs){f.hp=f.maxHp;f.combo=0;f.speedMod=0;f.dazed=false;f.fogged=false;f.poison=0;f.fever=0}HS.d++;HS.rn=0;hostRound(now)}
  /* between duels, once loaded faces are in play: three cards, the loser of the duel picks first and the winner from the two left; DRAFT_T seconds each */
  const DRAFT_T=8;
  function hostDraft(now){if(!featsFor(session.opts.spice||'std',HS.d+1).faces||HS.lastWin<0)return false;const loser=1-HS.lastWin;HS.cards=dealFaces(HS.rnd,HS.fs[loser],dieForRound(1,session.opts.dice));if(!HS.cards.length)return false;
    HS.taken=[];HS.turn=loser;HS.phase='draft';HS.at=now+DRAFT_T*1000;castDraft();return true}
  const castDraft=()=>cast({t:'draft',n:HS.n,cards:HS.cards,taken:HS.taken,turn:HS.turn,secs:DRAFT_T});
  function hostDrafted(who,ci){if(HS.phase!=='draft'||who!==HS.turn||!HS.cards[ci]||HS.taken.includes(ci))return;const f=HS.fs[who],c=HS.cards[ci],now=performance.now();
    if(!carve(f,c)){const free=freeFaces(f,dieForRound(1,session.opts.dice));if(free.length)carve(f,{kind:c.kind,face:free[0]})} // that number is carved on this one's die already: the next free one
    HS.taken=[...HS.taken,ci];if(who===1-HS.lastWin){HS.turn=HS.lastWin;HS.at=now+DRAFT_T*1000;castDraft()}else{HS.turn=-1;castDraft();HS.phase='ko';HS.at=now+900}}
  function handle(msg){
    switch(msg.t){
      case'round':if(msg.from===hostId&&Array.isArray(msg.f)&&msg.f.length===2&&Array.isArray(msg.w))onRound(msg);break;
      case'locked':if(msg.from===hostId&&msg.n===V.n&&!V.res){V.oppLocked=true;SFX.tick()}break;
      case'result':if(msg.from===hostId&&Array.isArray(msg.r)&&Array.isArray(msg.out)&&Array.isArray(msg.f))onResult(msg);break;
      case'pick':if(isHost&&msg.from!==hostId){const p=cleanPick(msg);if(p&&p.n===HS.n&&HS.bars)hostPick(1-V.me,HS.bars[1-V.me].presses===2?[p.u,p.u2]:p.u)}break;
      case'draft':if(msg.from===hostId&&Array.isArray(msg.cards)&&Array.isArray(msg.taken))onDraft(msg);break;
      case'drafted':if(isHost&&msg.from!==hostId&&Number.isInteger(msg.i))hostDrafted(1-V.me,msg.i);break;
      case'hello':if(isHost)HS.hello=true;break}}

  /* ---------- cards: the ☰ menu, how to play, the duel's result ---------- */
  function buttons(el,list){el.innerHTML='';for(const[label,cls,fn]of list){const b=document.createElement('button');b.className='btn '+cls;b.textContent=label;b.onclick=fn;el.appendChild(b)}}
  const nextLang=()=>setLang(LANGS[(LANGS.indexOf(lang)+1)%LANGS.length]);
  function renderMenu(){const list=[[T('resume'),'primary',()=>showMenu(false)],[T(audio.muted?'soundOff':'soundOn'),'',()=>{audio.toggle();renderMenu()}],[T('lang'),'',()=>{nextLang();renderMenu()}],[T('howto'),'',()=>{showMenu(false);showHelp(true)}]];
    if(canRun())list.push([T(!online?'restart':'playAgain'),'',()=>{showMenu(false);hooks.onRestart?.()}],[T(!online?'quit':'toLobby'),'',()=>{showMenu(false);hooks.onExit?.()}]);
    buttons(dom.pauseBtns,list)}
  function showMenu(on){dom.pause.classList.toggle('show',on);if(on)renderMenu()}
  function showHelp(on){dom.help.classList.toggle('show',on);if(on)dom.helpBody.innerHTML=T(V.on?'help.duel':'help.solo',{press:T(touch?'help.tap':'help.press'),hit:TO_HIT})}
  function showResult(R,forfeit){V.over=true;const won=forfeit||R.win===V.me,hearts=n=>(n/2).toString().replace('.5','½').replace(/^0½/,'½');
    dom.resKick.textContent=T('resKick',{n:V.target});dom.resTitle.textContent=T(forfeit?'walkedOff':won?'youWin':'youLose');dom.resTitle.className=won?'won':'lost';
    const row=(f,s,me)=>`<tr class="${me?'me':''}"><td><span class="sw" style="background:${esc(f.cfg.col)}"></span>${esc(nameOf(f))}</td><td>${s?s.wins:f.wins||0}</td><td>${s?s.perfects:'–'}</td><td>${s?s.crits:'–'}</td><td>${s?hearts(s.dealt):'–'}</td></tr>`;
    dom.resRows.innerHTML=`<table><tr><th></th><th>${T('thDuels')}</th><th>${T('thPerfects')}</th><th>${T('thCrits')}</th><th>${T('thDealt')}</th></tr>${row(P,R&&R.f[V.me],true)}${row(E,R&&R.f[1-V.me],false)}</table>`;
    buttons(dom.resBtns,isHost?[[T(forfeit?'playSolo':'playAgain'),'primary',()=>hooks.onRestart?.()],[T('toLobby'),'',()=>hooks.onExit?.()]]:[]);
    dom.resFoot.textContent=forfeit?T('leftRoom'):isHost?(touch?'':T('hostKeys')):T('waitHost');
    dom.result.classList.add('show');if(won)SFX.level()}
  dom.menuBtn.addEventListener('click',()=>{audio.init();showHelp(false);showMenu(!dom.pause.classList.contains('show'))});
  dom.pause.addEventListener('click',e=>{if(e.target===dom.pause)showMenu(false)});
  dom.help.addEventListener('click',e=>{if(e.target===dom.help)showHelp(false)});dom.helpOk.addEventListener('click',()=>showHelp(false));

  /* ---------- main loop. A card over a solo run pauses it; a duel cannot wait, so it goes on underneath. ---------- */
  const loop=createLoop(real=>{if(!session)return;const rdt=Math.min(.05,real);let dt=rdt;
    hostTick(performance.now());
    if(!V.on&&overlayOpen()){render();return}
    if(G.hitStop>0){G.hitStop-=rdt;dt=0}
    if(dt>0)update(dt,rdt);else if(G.state==='dead')G.deadT+=rdt;
    updateFx(rdt);render()});
  const ticker=createTicker(10,()=>{if(document.hidden)hostTick(performance.now())});

  /* ---------- session API ---------- */
  setLang(lang);
  function start(s){session=s;isHost=!!s.isHost;online=!!s.online;hostId=s.hostId;
    showMenu(false);showHelp(false);dom.result.classList.remove('show');parts.length=0;fx.length=0;words.length=0;G.shake=0;G.hitStop=0;G.flashBG=0;
    if(s.players.length>=2)duelStart(s);else{V.on=false;V.me=0;resetRun(false)} // alone, in a room or not, it is the run against the CPU ladder
    audio.init();kb.attach();fit();loop.start();if(V.on&&isHost)ticker.start();else ticker.stop()}
  function stop(){session=null;V.on=false;HS.phase='idle';kb.detach();ticker.stop();loop.stop();showMenu(false);showHelp(false);dom.result.classList.remove('show')}
  function destroy(){stop();ticker.dispose();unsubAudio();try{master?.disconnect()}catch{}ro?.disconnect();removeEventListener('resize',fit);root.remove();mount.innerHTML='';unloadCss();if(window.__dice===debug)delete window.__dice}
  function playerLeft(){if(!session||!V.on||V.over)return;HS.phase='idle';G.phase='over';showResult(V.res,true)} // a duel of one is over: the one who stayed takes it
  function onNetMessage(msg){if(!session||!V.on||V.over||!msg||msg.m!==V.m)return;handle(msg)}
  const debug={G,V,HS,SOLO,get P(){return P},get E(){return E},get compact(){return compact},press,fit,touch};
  window.__dice=debug;
  return{start,stop,destroy,onNetMessage,playerLeft,debug};
}
