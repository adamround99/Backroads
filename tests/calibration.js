const fs=require('fs'); const src=fs.readFileSync(__dirname+'/../app.js','utf8');
let stored={};
global.localStorage={getItem:k=>stored[k]||null,setItem:(k,v)=>stored[k]=v,removeItem:k=>delete stored[k]};
const vm=require('vm');
["paceSamples","addPaceSample","paceFactor"].forEach(n=>{
  const m=src.match(new RegExp("function "+n+"\\([\\s\\S]*?\\n\\}"));
  vm.runInThisContext(m[0]);
});
vm.runInThisContext("var paceCache=null; var PACE_STORE=\"backroads.pace\";");

function reset(){ stored={}; paceCache=null; }
function feed(ratios){ reset(); ratios.forEach(r=>addPaceSample(r)); return paceFactor(); }

console.log("no data                       ->", feed([]).toFixed(3), "(must be 1)");
console.log("consistently 20% slower       ->", feed([1.2,1.18,1.22,1.21]).toFixed(3));
console.log("consistently 15% quicker      ->", feed([0.85,0.86,0.84]).toFixed(3));
console.log("one fuel stop among 4 normals ->", feed([1.05,1.03,2.4,1.04,1.06]).toFixed(3), "(outlier ignored?)");
console.log("two wild entries              ->", feed([1.05,9.0,0.01,1.03,1.06]).toFixed(3));
console.log("absurd single entry           ->", feed([25]).toFixed(3), "(clamped)");
console.log("absurd low single entry       ->", feed([0.01]).toFixed(3), "(clamped)");
console.log();
// drift check: does repeatedly correcting converge or oscillate?
reset();
let truth=1.25, est=60;
console.log("convergence: true pace 1.25, asking for 60 min each time");
for(let i=1;i<=6;i++){
  const raw = 60/paceFactor();          // what the walk targets
  const actual = raw*truth;             // what the drive really takes
  addPaceSample(actual/raw);
  console.log("  drive "+i+": predicted "+Math.round(raw*paceFactor())+
    "m, actual "+actual.toFixed(1)+"m, factor now "+paceFactor().toFixed(3));
}
console.log();
console.log("cap: only last 10 kept ->", (()=>{reset();for(let i=0;i<15;i++)addPaceSample(1+i/100);return paceSamples().length})());
