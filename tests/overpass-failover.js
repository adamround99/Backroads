// Exercise askOverpass against mocked servers.
const OVERPASS=["A","B","C"];
let log=[];
global.say=m=>log.push("say:"+m);
global.AbortController=class{constructor(){this.signal={}}abort(){}};
global.window=global;
global.navigator={onLine:true};

function makeFetch(behaviour){
  return (url)=> {
    log.push(url);
    const b=behaviour[url];
    if(b==="net") return Promise.reject(new Error("network"));
    if(typeof b==="number") return Promise.resolve({ok:b<400,status:b,json:()=>Promise.resolve({elements:[]})});
    return Promise.resolve({ok:true,status:200,json:()=>Promise.resolve({elements:["data"]})});
  };
}

const src=require('fs').readFileSync(__dirname+'/../app.js','utf8');
const fn=src.match(/function askOverpass\(q\)\{[\s\S]*?\n\}/)[0];
eval(fn);

async function run(name,behaviour,expectOk){
  log=[]; global.fetch=makeFetch(behaviour);
  const t=Date.now();
  try{ const r=await askOverpass("q");
    console.log(name,"| OK   |",(Date.now()-t)+"ms |",log.filter(x=>x.length===1).join(">"), expectOk?"":"  <-- EXPECTED FAIL");
  }catch(e){
    console.log(name,"| FAIL |",(Date.now()-t)+"ms |",log.filter(x=>x.length===1).join(">"),"|",e.message, expectOk?"  <-- EXPECTED OK":"");
  }
}
(async()=>{
  await run("first works      ",{A:200,B:200,C:200},true);
  await run("A busy, B works  ",{A:429,B:200,C:200},true);
  await run("A,B down C works ",{A:"net",B:504,C:200},true);
  await run("all busy         ",{A:429,B:429,C:504},false);
  await run("all offline      ",{A:"net",B:"net",C:"net"},false);
  await run("bad query (400)  ",{A:400,B:200,C:200},false);
})();
