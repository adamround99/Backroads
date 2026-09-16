const fs=require('fs'),vm=require('vm'); const src=fs.readFileSync(__dirname+'/../app.js','utf8');
["placesAlong","viaPicked","sentence","anchorPlace"].forEach(n=>{
  vm.runInThisContext(src.match(new RegExp("function "+n+"\\([\\s\\S]*?\\n\\}"))[0]);
});
vm.runInThisContext(src.match(/var PLACE_REACH = \{[^}]*\};/)[0]);
const latScale=111320*Math.cos(52.3*Math.PI/180);

// Places roughly on a 25km line east of a start point.
const places=[
  {name:"Napton",   kind:"village", lon:-1.60,  lat:52.30},
  {name:"Southam",  kind:"town",    lon:-1.55,  lat:52.30},
  {name:"Ladbroke", kind:"hamlet",  lon:-1.50,  lat:52.301},
  {name:"Byfield",  kind:"village", lon:-1.45,  lat:52.30},
  {name:"Woodford", kind:"hamlet",  lon:-1.40,  lat:52.30},
  {name:"Eydon",    kind:"village", lon:-1.35,  lat:52.30},
  {name:"Miles away",kind:"village",lon:-1.35,  lat:52.40},   // far off route
];
// A route running straight along that line and back.
const pts=[]; for(let i=0;i<=200;i++) pts.push([-1.62+ (0.29*i/200), 52.300]);

const found = placesAlong(places, pts, latScale);
console.log("passed, in order:", found.map(p=>p.name+"("+p.kind+")").join(" -> "));
console.log("far-off village excluded:", !found.some(p=>p.name==="Miles away"));
console.log();
[6,4,3].forEach(m=>console.log("thinned to "+m+":", sentence(viaPicked(found,m).map(p=>p.name))));
console.log();
console.log("lap named after:", anchorPlace(found)+" loop");
console.log();
// A hamlet 600m off the road should NOT count; a town 1.2km off should.
const off=[{name:"Tiny",kind:"hamlet",lon:-1.50,lat:52.3054},
           {name:"Bigton",kind:"town",lon:-1.45,lat:52.3100}];
const f2=placesAlong(off,pts,latScale);
console.log("hamlet 600m off route counted:", f2.some(p=>p.name==="Tiny"), "(want false)");
console.log("town 1.1km off route counted: ", f2.some(p=>p.name==="Bigton"), "(want true)");
