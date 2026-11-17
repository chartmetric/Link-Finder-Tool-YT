// Only deeply frozen plain JSON graphs can reuse a successful pure result.
// Mutable inputs, accessors, Dates, Maps and failed validations are never cached.
const immutable=new WeakSet();
export function deeplyImmutable(value,visiting=new WeakSet()){
  if(value===null||['string','number','boolean','undefined'].includes(typeof value))return true;
  if(typeof value!=='object'||!Object.isFrozen(value))return false;
  if(immutable.has(value)||visiting.has(value))return true;
  const proto=Object.getPrototypeOf(value);
  if(proto!==Object.prototype&&proto!==Array.prototype&&proto!==null)return false;
  if(Reflect.ownKeys(value).some(k=>typeof k==='symbol'))return false;
  visiting.add(value);
  for(const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))){
    if(!('value' in descriptor)||!deeplyImmutable(descriptor.value,visiting))return false;
  }
  immutable.add(value);return true;
}
function freezeResult(value,seen=new WeakSet()){
  if(value&&typeof value==='object'&&!seen.has(value)){
    seen.add(value);for(const v of Object.values(value))freezeResult(v,seen);Object.freeze(value);
  }
  return value;
}
export function immutableValidationCache(validate){
  const root=new WeakMap();
  return function(...args){
    if(!args.length||!args.every(a=>a&&typeof a==='object'&&deeplyImmutable(a)))return validate(...args);
    let entries=root;
    for(const [i,arg] of args.entries()){
      let entry=entries.get(arg);
      if(!entry){entry={next:new WeakMap(),ready:false};entries.set(arg,entry);}
      if(i===args.length-1){
        if(entry.ready)return entry.result;
        const result=validate(...args);
        entry.result=freezeResult(result);entry.ready=true;return entry.result;
      }
      entries=entry.next;
    }
  };
}
