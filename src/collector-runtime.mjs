import {Worker, isMainThread, parentPort, workerData} from 'node:worker_threads';

// The HTTP thread serves the last published value only. SQLite scans, log reads,
// credentials and network collection all stay in the background worker.
export function startCollectorRuntime(options, {intervalMs = 10000} = {}) {
  let latest = {schemaVersion:1, observedAt:new Date().toISOString(), providers:[],
    warnings:['저장된 쿼타 기록을 불러오고 있습니다.'], refreshIntervalSeconds:10,
    analytics:{status:'collecting', usageStale:true, lastCollectedAt:null}};
  let closed = false, exited = false;
  const failureNote = '수집 작업이 중단되어 마지막 기록을 표시합니다.';
  const worker = new Worker(new URL(import.meta.url), {workerData:{options, intervalMs}});
  const failed = () => {
    if (closed) return;
    latest = {...latest, warnings:[...new Set([...(latest.warnings ?? []), failureNote])],
      analytics:{...latest.analytics, status:'error', usageStale:true}};
  };
  worker.on('message', message => {
    if (message.type === 'snapshot' && !closed) latest = message.value;
    if (message.type === 'failure') failed();
  });
  worker.on('error', failed);
  worker.on('exit', () => {exited = true; failed();});
  return {
    // No IPC, file access, DB query or collection promise in the request path.
    snapshot:async () => {
      const age = Date.now() - Date.parse(latest.observedAt);
      return age <= Math.max(intervalMs * 3, 30000) ? latest : {...latest,
        warnings:[...new Set([...(latest.warnings ?? []), failureNote])],
        analytics:{...latest.analytics, status:'error', usageStale:true}};
    },
    async close() {
      if (closed || exited) return;
      closed = true;
      const done = new Promise(resolve => worker.once('exit', resolve));
      worker.postMessage({type:'close'});
      const timeout = setTimeout(() => void worker.terminate(), 8000);
      timeout.unref();
      await done;
      clearTimeout(timeout);
    },
  };
}

if (!isMainThread && parentPort) {
  const {createCollector} = await import('./collector.mjs');
  const {directOptions} = await import('./direct-adapters.mjs');
  const {directProviders, ...options} = workerData.options;
  const collector = await createCollector({...options,
    ...directOptions({QUOTA_DIRECT_PROVIDERS:directProviders}, {home:options.home})});
  let publishing = null, stopping = false;
  const publish = () => {
    if (stopping) return Promise.resolve();
    if (publishing) return publishing;
    publishing = (async () => {
      try {
        const value = await collector.snapshot();
        // Published DTO contains no symbol/private identity metadata.
        if (!stopping) parentPort.postMessage({type:'snapshot', value:JSON.parse(JSON.stringify(value))});
      } catch {if (!stopping) parentPort.postMessage({type:'failure'});}
    })().finally(() => {publishing = null;});
    return publishing;
  };
  let timer, quotaTimer, cycle = null;
  const update = () => {
    if (stopping || cycle) return cycle;
    cycle = (async () => {await collector.collect({waitForQuota:false}); await publish();})()
      .catch(() => {if (!stopping) parentPort.postMessage({type:'failure'});})
      .finally(() => {cycle = null;});
    return cycle;
  };
  parentPort.on('message', async message => {
    if (message.type !== 'close' || stopping) return;
    stopping = true; clearInterval(timer); clearInterval(quotaTimer);
    await cycle; await publishing; await collector.close(); parentPort.close();
  });
  // Read retained data first, without waiting for any provider or usage-log scan.
  await publish();
  if (!stopping) {
    timer = setInterval(() => void update(), workerData.intervalMs);
    quotaTimer = setInterval(() => void collector.collectQuota({wait:false}), options.intervalMs ?? 10000);
    void collector.collectQuota({wait:false});
    void update();
  }
}
