(function(root){
  'use strict';
  let database;
  function open(){
    if(!database)database=new Promise((resolve,reject)=>{
      const request=indexedDB.open('hawaya-push-v1',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('bindings');
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>{database=null;reject(request.error);};
    });
    return database;
  }
  root.HawayaPushStore={
    async get(scope){const db=await open();return new Promise((resolve,reject)=>{const request=db.transaction('bindings').objectStore('bindings').get(scope);request.onsuccess=()=>resolve(request.result||null);request.onerror=()=>reject(request.error);});},
    async set(scope,value){const db=await open();return new Promise((resolve,reject)=>{const tx=db.transaction('bindings','readwrite');tx.objectStore('bindings').put(value,scope);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
  };
})(typeof self==='undefined'?window:self);
