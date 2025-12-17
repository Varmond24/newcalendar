(function() {
  const state = { canvas:null, ctx:null, flakes:[], animId:null, count:180, running:false, lastW:0, lastH:0 };
  const rand = (a,b)=>Math.random()*(b-a)+a;

  function resize() {
    if (!state.canvas) return;
    const dpr = Math.min(window.devicePixelRatio||1, 2);
    const w = window.innerWidth, h = window.innerHeight;
    if (w===state.lastW && h===state.lastH) return;
    state.lastW=w; state.lastH=h;
    state.canvas.width = Math.floor(w*dpr);
    state.canvas.height = Math.floor(h*dpr);
    state.canvas.style.width = w+'px';
    state.canvas.style.height = h+'px';
    state.ctx.setTransform(dpr,0,0,dpr,0,0);
  }
  function initFlakes() {
    const w = window.innerWidth, h = window.innerHeight;
    state.flakes = new Array(state.count).fill(0).map(()=>({
      x: rand(0,w), y: rand(-h,h), r: rand(1,3.2), sx: rand(-0.6,0.6), sy: rand(0.6,1.8), o: rand(0.5,1)
    }));
  }
  function step() {
    const { ctx, flakes } = state;
    const w = window.innerWidth, h = window.innerHeight;
    ctx.clearRect(0,0,w,h);
    ctx.save(); ctx.fillStyle='#fff';
    flakes.forEach(f=>{
      f.x+=f.sx; f.y+=f.sy;
      if (f.x>w+5) f.x=-5; if (f.x<-5) f.x=w+5;
      if (f.y>h+5) { f.x=rand(0,w); f.y=-10; }
      ctx.globalAlpha=f.o; ctx.beginPath(); ctx.arc(f.x,f.y,f.r,0,Math.PI*2); ctx.fill();
    });
    ctx.restore();
    state.animId = requestAnimationFrame(step);
  }
  function ensureCanvas() {
    if (state.canvas) return;
    const c = document.getElementById('snow-canvas') || document.createElement('canvas');
    c.id='snow-canvas'; c.className='snow-canvas';
    document.body.appendChild(c);
    state.canvas=c; state.ctx=c.getContext('2d');
    resize(); initFlakes();
    window.addEventListener('resize', ()=>{ resize(); initFlakes(); });
  }
  function start(){ if(state.running) return; ensureCanvas(); state.running=true; cancelAnimationFrame(state.animId); step(); }
  function stop(){ state.running=false; cancelAnimationFrame(state.animId); state.ctx?.clearRect(0,0,window.innerWidth,window.innerHeight); }
  function setIntensity(n){ state.count=Math.max(10,Math.min(600,n|0)); if(state.running) initFlakes(); }

  window.Snow = { start, stop, setIntensity };
})();