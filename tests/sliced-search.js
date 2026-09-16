const fs=require('fs');
const el=()=>({style:{},classList:{add(){},remove(){},toggle(){}},dataset:{},
  addEventListener(){},appendChild(){},querySelectorAll:()=>[],querySelector:()=>el(),
  set innerHTML(v){},set textContent(v){},set className(v){},set hidden(v){}});
global.document={getElementById:el,querySelectorAll:()=>[],addEventListener(){},
  body:{classList:{toggle(){},add(){},remove(){}},dataset:{}},createElement:el};
global.window={addEventListener(){},dispatchEvent(){},matchMedia:()=>({matches:false,addEventListener(){}})};
global.navigator={onLine:true,geolocation:{getCurrentPosition(){}}};
global.localStorage={getItem:()=>null,setItem(){},removeItem(){}};
global.Event=class{constructor(t){this.type=t}};
global.L={map:()=>({setView(){return this},on(){return this},fitBounds(){},addLayer(){},removeLayer(){},getSize:()=>({x:400,y:400}),project:p=>({x:0,y:0}),unproject:p=>[0,0],getZoom:()=>11,invalidateSize(){}}),
  tileLayer:()=>({addTo(){return this},setUrl(){}}),polyline:()=>({addTo(){return this},getBounds:()=>({})}),
  marker:()=>({addTo(){return this},getElement:()=>null}),divIcon:()=>({}),latLngBounds:()=>({extend(){}})};
global.fetch=()=>Promise.reject(new Error("no network"));
let frames=0;
global.requestAnimationFrame=fn=>{frames++; setImmediate(fn);};

const src=fs.readFileSync(__dirname+'/../app.js','utf8');
const body=require('fs').readFileSync(__dirname+'/../app.js','utf8').replace(/\ninit\(\);[\s\S]*$/,'\n');
require('vm').runInThisContext(body);

// same synthetic network as the other tests
function mkWays(){
  const ways=[]; let id=1; const N=25, spacing=0.011, lat0=52.35, lon0=-1.60;
  const pt=(r,c,j)=>{const w=j?Math.sin(r*3.1+c*1.7)*0.0016:0;
    return {lat:lat0+r*spacing+w, lon:lon0+c*spacing*1.6+w*1.2};};
  for(let r=0;r<N;r++)for(let c=0;c<N-1;c++){
    const tw=(r>6&&c<6), geo=[], steps=tw?9:3;
    for(let k=0;k<=steps;k++){const f=k/steps,a=pt(r,c,tw),b=pt(r,c+1,tw);
      const w=tw?Math.sin(f*Math.PI*3)*0.0011:0;
      geo.push({lat:a.lat+(b.lat-a.lat)*f+w, lon:a.lon+(b.lon-a.lon)*f});}
    ways.push({type:"way",id:id++,geometry:geo,tags:{highway:tw?"unclassified":(r%4===0?"secondary":"tertiary")}});}
  for(let c=0;c<N;c++)for(let r=0;r<N-1;r++){
    const tw=(r>=6&&c<6), geo=[], steps=tw?9:3;
    for(let k=0;k<=steps;k++){const f=k/steps,a=pt(r,c,tw),b=pt(r+1,c,tw);
      const w=tw?Math.sin(f*Math.PI*3)*0.0011:0;
      geo.push({lat:a.lat+(b.lat-a.lat)*f, lon:a.lon+(b.lon-a.lon)*f+w});}
    ways.push({type:"way",id:id++,geometry:geo,tags:{highway:tw?"unclassified":(c%4===0?"secondary":"tertiary")}});}
  return ways;
}
const latScale=110540*Math.cos(52.35*Math.PI/180);
let g=mergeChains(pruneSpurs(buildGraph(mkWays(),latScale,null,null)),5000);
const start={lat:52.35+6*0.011,lng:-1.60+6*0.011*1.6};

const sync=findCircuits(g,start,60*60,8000,200);
let improvements=0, firstAt=null, ticks=0;
const t0=Date.now();
findCircuitsLive(g,start,60*60,8000,200,
  b=>{ improvements++; if(firstAt===null) firstAt=Date.now()-t0; },
  ()=>{ ticks++; }
).then(live=>{
  const key=r=>r.found.map(x=>Math.round(x.total*1000)).sort().join(",");
  console.log("straight through : "+sync.found.length+" laps");
  console.log("sliced           : "+live.found.length+" laps");
  console.log("identical result :", key(sync)===key(live));
  console.log();
  console.log("frames yielded   :", frames);
  console.log("ticks            :", ticks);
  console.log("best-so-far shown:", improvements, "times");
  console.log("first lap drawn  :", firstAt+"ms into the search");
  const bs=sync.found.slice().sort((a,b)=>b.total-a.total)[0];
  const bl=live.found.slice().sort((a,b)=>b.total-a.total)[0];
  console.log("same winner      :", Math.round(bs.total*1e6)===Math.round(bl.total*1e6));
});
