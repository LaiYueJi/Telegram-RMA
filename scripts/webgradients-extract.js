const fs=require("fs");
const p=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
function walk(l,cb){ cb(l); (l.layers||[]).forEach(x=>walk(x,cb)); }
const pt=s=>{const m=/\{([-0-9.]+),\s*([-0-9.]+)\}/.exec(s||"");return m?[+m[1],+m[2]]:null;};
const h2=v=>{let x=Math.round(v*255);x=Math.max(0,Math.min(255,x));return x.toString(16).padStart(2,"0");};
const hex=c=>"#"+h2(c.red)+h2(c.green)+h2(c.blue);
const items=[];
walk(p,l=>{
  const n=l.name||""; const m=/^(\d+)\s+(.+)$/.exec(n); if(!m) return;
  const fill=(l.style&&l.style.fills||[]).find(f=>f.gradient&&f.gradient.gradientType===0); if(!fill) return;
  const g=fill.gradient; const f=pt(g.from),t=pt(g.to);
  if(!f||!t) return;
  const dx=t[0]-f[0],dy=t[1]-f[1];
  let ang=Math.round((Math.atan2(-dx,dy)*180/Math.PI+360)%360);
  const stops=g.stops.slice().reverse().map(s=>hex(s.color)+" "+Math.round((1-s.position)*100)+"%").join(", ");
  const css=`linear-gradient(${ang}deg, ${stops})`;
  const id=m[2].toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
  items.push({num:+m[1], id, en:m[2], css});
});
items.sort((a,b)=>a.num-b.num);
console.log("TOTAL:",items.length);
const present=new Set(items.map(i=>i.num));
const missing=[];for(let i=1;i<=180;i++)if(!present.has(i))missing.push(i);
console.log("MISSING nums:",missing.join(","));
fs.writeFileSync(process.argv[3], JSON.stringify(items,null,0));
items.slice(0,6).forEach(i=>console.log(i.num,i.en,"|",i.css));
