import test from 'node:test';
import assert from 'node:assert/strict';
import {deeplyImmutable,immutableValidationCache} from './youtube-immutable-validation-cache.mjs';
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
test('deeply frozen JSON inputs reuse successful results; outputs cannot be changed',()=>{
  let calls=0;
  const f=immutableValidationCache((a,b)=>{calls++;return {sum:a.n+b.n,nested:{valid:true}};});
  const a=freeze({n:2}),b=freeze({n:3});
  const first=f(a,b);assert.equal(f(a,b),first);assert.equal(calls,1);
  assert.throws(()=>{first.nested.valid=false;});assert.equal(f(a,b).nested.valid,true);
  assert.equal(f(a,freeze({n:3})).sum,5);assert.equal(calls,2);
});
test('mutable nested input cannot inherit a cached approval and changed fields are revalidated',()=>{
  let calls=0;const f=immutableValidationCache(p=>{calls++;assert.equal(p.request.url,'approved');return true;});
  const mutable={request:{url:'approved'}};f(mutable);f(mutable);assert.equal(calls,2);
  mutable.request.url='changed';assert.throws(()=>f(mutable));assert.equal(calls,3);
  const shallow=Object.freeze({request:{url:'approved'}});f(shallow);
  shallow.request.url='changed';assert.throws(()=>f(shallow));
});
test('failed checks are never cached, and mutable Map or accessor internals are refused',()=>{
  let calls=0;const f=immutableValidationCache(()=>{calls++;throw Error('blocked');});
  const input=freeze({value:1});
  assert.throws(()=>f(input));assert.throws(()=>f(input));assert.equal(calls,2);
  assert.equal(deeplyImmutable(Object.freeze(new Map())),false);
  assert.equal(deeplyImmutable(Object.freeze({get value(){return 1;}})),false);
  assert.equal(deeplyImmutable(Object.freeze(new Date())),false);
});
