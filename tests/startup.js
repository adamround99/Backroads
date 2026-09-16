const fs=require('fs'); const src=fs.readFileSync(__dirname+'/../index.html','utf8')+fs.readFileSync(__dirname+'/../app.js','utf8');
// every id that genuinely exists in the markup
const ids=new Set([...src.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]));
console.log("ids in markup:", ids.size);

const missing=new Set();
function el(id){
  return {id, style:{}, dataset:{},
    classList:{add(){},remove(){},toggle(){}},
    addEventListener(){}, appendChild(){}, removeChild(){},
    querySelectorAll:()=>[], querySelector:()=>el("x"),
    setAttribute(){}, getAttribute:()=>null, remove(){},
    set innerHTML(v){}, get innerHTML(){return ""},
    set textContent(v){}, get textContent(){return ""},
    set className(v){}, set hidden(v){}, set disabled(v){}};
}
global.document={
  getElementById(id){ if(!ids.has(id)){ missing.add(id); return null; } return el(id); },
  querySelectorAll:()=>[], addEventListener(){}, createElement:()=>el("new"),
  body:{classList:{toggle(){},add(){},remove(){}},dataset:{},appendChild(){},removeChild(){}},
  readyState:"complete"
};
global.window={addEventListener(){},dispatchEvent(){},open(){},
  matchMedia:()=>({matches:false,addEventListener(){}}),indexedDB:null};
global.navigator={onLine:true,geolocation:null,wakeLock:undefined};
global.localStorage={getItem:()=>null,setItem(){},removeItem(){}};
global.Event=class{constructor(t){this.type=t}};
global.getComputedStyle=()=>({getPropertyValue:()=>"#000"});
global.requestAnimationFrame=fn=>setImmediate(fn);
global.cancelAnimationFrame=()=>{};
global.fetch=()=>Promise.reject(new Error("no net"));
global.L={map:()=>({setView(){return this},on(){return this},fitBounds(){},addLayer(){},
    removeLayer(){},getSize:()=>({x:400,y:600}),getZoom:()=>11,invalidateSize(){},
    project:()=>({x:0,y:0}),unproject:()=>[0,0],latLngToContainerPoint:()=>({x:0,y:0})}),
  tileLayer:()=>({addTo(){return this},setUrl(){}}),
  polyline:()=>({addTo(){return this},getBounds:()=>({}),setStyle(){},setRadius(){}}),
  circle:()=>({addTo(){return this},setStyle(){},setRadius(){}}),
  marker:()=>({addTo(){return this},getElement:()=>null,setLatLng(){}}),
  divIcon:()=>({}),layerGroup:()=>({addTo(){return this},bringToBack(){}}),
  canvas:()=>({}),latLngBounds:()=>({extend(){}})};

const body=require('fs').readFileSync(__dirname+'/../app.js','utf8');
try{
  require('vm').runInThisContext(body);
  console.log("\nstartup completed without throwing");
}catch(e){
  console.log("\nSTARTUP THREW:", e.message);
  console.log(e.stack.split("\n").slice(0,4).join("\n"));
}
if(missing.size) console.log("\nlooked for ids that don't exist:", [...missing].join(", "));

// Guard against exactly the mistake that caused this: a control in the markup
// with nothing bound to it.
const wired=new Set([...src.matchAll(/getElementById\("([^"]+)"\)\.addEventListener/g)].map(m=>m[1]));
const chipBoxes=new Set([...src.matchAll(/wireChips\("([^"]+)"/g)].map(m=>m[1]));
const buttons=[...src.matchAll(/<button id="([^"]+)"/g)].map(m=>m[1]);
const chipKids=new Set();
[...src.matchAll(/<div class="chips" id="([^"]+)"[\s\S]*?<\/div>/g)].forEach(m=>{
  if(chipBoxes.has(m[1])) [...m[0].matchAll(/<button data-v/g)].forEach(()=>{});
});
console.log("\nbutton wiring check:");
buttons.forEach(id=>{
  const inChips = [...src.matchAll(/<div class="chips" id="([^"]+)">([\s\S]*?)<\/div>/g)]
    .some(m=>chipBoxes.has(m[1]) && m[2].includes('id="'+id+'"'));
  const ok = wired.has(id) || inChips;
  console.log("  "+(ok?"ok    ":"UNWIRED ")+id);
});
