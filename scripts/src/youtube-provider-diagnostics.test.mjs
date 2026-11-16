import './youtube-ownership-offline-fence.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {providerStopReason} from './youtube-ownership-transport.mjs';

test('successful search and channel content cannot masquerade as provider failures',()=>{
  for(const data of [
    {searchParameters:{q:'Unauthorized musician youtube'},organic:[
      {title:'Madonna: The Unauthorized Rusical',snippet:'Unauthorized music video'},
      {title:'Not Enough Credits',snippet:'Payment required / billing limit / invalid API key'},
    ],credits:1},
    {success:true,name:'Unauthorized',description:'Authentication failed: a song',credits_charged:1},
    {answers:{verdict:{choice:'uncertain'},reason:{text:'The biography mentions insufficient credits'}}},
  ])assert.equal(providerStopReason({status:200,data}),null);
});
test('real provider diagnostics, HTTP failures and malformed replies still stop dispatch',()=>{
  for(const [packet,reason] of [
    [{status:200,data:{error:{message:'invalid API key'}}},'provider_authentication_or_access_failure'],
    [{status:200,data:{message:'authentication failed'}},'provider_authentication_or_access_failure'],
    [{status:200,data:{errors:['insufficient credits']}},'provider_funding_failure'],
    [{status:401,data:{organic:[]}},'provider_authentication_or_access_failure'],
    [{status:403,data:{organic:[]}},'provider_authentication_or_access_failure'],
    [{status:402,data:{}},'provider_funding_failure'],
    [{status:429,data:{}},'provider_rate_limit'],
    [{status:302,data:{}},'unexpected_provider_redirect'],
    [{status:200,data:null,parseFailed:true},'unreadable_provider_response'],
    [{status:200,data:{success:false}},'provider_protocol_failure'],
    [{status:200,data:{error:'unknown provider error'}},'provider_protocol_failure'],
  ])assert.equal(providerStopReason(packet),reason);
});
