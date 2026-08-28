"use components";
export function instantiate(getCoreModule, imports, instantiateCore = WebAssembly.instantiate) {
  
  let dv = new DataView(new ArrayBuffer());
  const dataView = mem => dv.buffer === mem.buffer ? dv : dv = new DataView(mem.buffer);
  
  function toUint64(val) {
    const converted = BigInt(val)
    
    return BigInt.asUintN(64, converted);
  }
  
  
  function toUint16(val) {
    
    val >>>= 0;
    val %= 2 ** 16;
    return val;
  }
  
  
  function _isValidNumericPrimitive(ty, v) {
    if (v === undefined || v === null) { return false; }
    switch (ty) {
      case 'bool':
      return v === 0 || v === 1;
      break;
      case 'u8':
      return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255;
      break;
      case 's8':
      return typeof v === 'number' && Number.isInteger(v) && v >= -128 && v <= 127;
      break;
      case 'u16':
      return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 65535;
      break;
      case 's16':
      return typeof v === 'number' && Number.isInteger(v) && v >= -32768 && v <= 32767;
      case 'u32':
      return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 4_294_967_295;
      case 's32':
      return typeof v === 'number' && Number.isInteger(v) && v >= -2_147_483_648 && v <= 2_147_483_647;
      case 'u64':
      return typeof v === 'bigint' && v >= 0 && v <= 18_446_744_073_709_551_615n;
      case 's64':
      return typeof v === 'bigint' && v >= -9223372036854775808n && v <= 9223372036854775807n;
      break;
      case 'f32':
      case 'f64': return typeof v === 'number';
      default:
      return false;
    }
    return true;
  }
  
  function _requireValidNumericPrimitive(ty, v) {
    if (v === undefined  || v === null || !_isValidNumericPrimitive(ty, v)) {
      throw new TypeError(`invalid ${ty} value [${v}]`);
    }
    return true;
  }
  const utf16Decoder = new TextDecoder('utf-16');
  
  const isLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  
  function _utf16AllocateAndEncode(str, realloc, memory) {
    const len = str.length;
    const ptr = realloc(0, 0, 2, len * 2);
    const out = new Uint16Array(memory.buffer, ptr, len);
    let i = 0;
    if (isLE) {
      while (i < len) { out[i] = str.charCodeAt(i++); }
    } else {
      while (i < len) {
        const ch = str.charCodeAt(i);
        out[i++] = (ch & 0xff) << 8 | ch >>> 8;
      }
    }
    return { ptr, len, codepoints: [...str].length };
  }
  
  const TEXT_DECODER_UTF8 = new TextDecoder();
  const TEXT_ENCODER_UTF8 = new TextEncoder();
  
  function _utf8AllocateAndEncode(s, realloc, memory) {
    if (typeof s !== 'string') {
      throw new TypeError('expected a string, received [' + typeof s + ']');
    }
    if (s.length === 0) { return { ptr: 1, len: 0 }; }
    // Compute the exact allocation size up front. Some older preview1
    // adapters only support an initial allocation, not a subsequent shrink.
    let len = 0;
    let codepoints = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      codepoints++;
      if (ch < 0x80) { len += 1; }
      else if (ch < 0x800) { len += 2; }
      else if (ch >= 0xd800 && ch <= 0xdbff &&
      i + 1 < s.length &&
      (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
        len += 4;
        i++;
      } else { len += 3; }
    }
    const ptr = realloc(0, 0, 1, len);
    const { read, written } = TEXT_ENCODER_UTF8.encodeInto(
    s,
    new Uint8Array(memory.buffer, ptr, len),
    );
    if (read !== s.length || written !== len) {
      throw new Error('failed to encode whole string');
    }
    const res = { ptr, len, codepoints };
    return res;
  }
  
  const T_FLAG = 1 << 30;
  
  function rscTableCreateOwn(table, rep) {
    const free = table[0] & ~T_FLAG;
    table._createdReps.add(rep);
    if (free === 0) {
      table.push(0);
      table.push(rep | T_FLAG);
      return (table.length >> 1) - 1;
    }
    table[0] = table[free << 1];
    table[free << 1] = 0;
    table[(free << 1) + 1] = rep | T_FLAG;
    return free;
  }
  
  
  function rscTableRemove(table, handle) {
    const scope = table[handle << 1];
    const val = table[(handle << 1) + 1];
    const own = (val & T_FLAG) !== 0;
    const rep = val & ~T_FLAG;
    if (val === 0 || (scope & T_FLAG) !== 0) {
      throw new TypeError("Invalid handle");
    }
    table[handle << 1] = table[0] | T_FLAG;
    table[0] = handle | T_FLAG;
    return { rep, scope, own };
  }
  
  
  let curResourceBorrows = [];
  const ASYNC_TASKS_BY_COMPONENT_IDX = new Map();
  const ASYNC_CURRENT_COMPONENT_IDXS = [];
  
  function getCurrentTask(componentIdx, taskID) {
    let usedGlobal = false;
    if (componentIdx === undefined || componentIdx === null) {
      throw new Error('missing component idx'); // TODO(fix)
      // componentIdx = ASYNC_CURRENT_COMPONENT_IDXS.at(-1);
      // usedGlobal = true;
    }
    
    const taskMetas = ASYNC_TASKS_BY_COMPONENT_IDX.get(componentIdx);
    if (taskMetas === undefined || taskMetas.length === 0) { return undefined; }
    
    if (taskID) {
      return taskMetas.find(meta => meta.task.id() === taskID);
    }
    
    const taskMeta = taskMetas[taskMetas.length - 1];
    if (!taskMeta || !taskMeta.task) { return undefined; }
    
    return taskMeta;
  }
  const ASYNC_CURRENT_TASK_IDS = [];
  
  const _debugLog = (...args) => {
    if (!globalThis?.process?.env?.JCO_DEBUG) { return; }
    console.debug(...args);
  };
  
  function clearCurrentTask(componentIdx, taskID) {
    _debugLog('[clearCurrentTask()] args', { componentIdx, taskID });
    
    if (componentIdx === undefined || componentIdx === null) {
      throw new Error('missing/invalid component instance index while ending current task');
    }
    
    const tasks = ASYNC_TASKS_BY_COMPONENT_IDX.get(componentIdx);
    if (!tasks || !Array.isArray(tasks)) {
      throw new Error('missing/invalid tasks for component instance while ending task');
    }
    if (tasks.length == 0) {
      throw new Error(`no current tasks for component instance [${componentIdx}] while ending task`);
    }
    
    if (taskID !== undefined) {
      const last = tasks[tasks.length - 1];
      if (last.id !== taskID) {
        // throw new Error('current task does not match expected task ID');
        return;
      }
    }
    
    ASYNC_CURRENT_TASK_IDS.pop();
    ASYNC_CURRENT_COMPONENT_IDXS.pop();
    
    const taskMeta = tasks.pop();
    return taskMeta.task;
  }
  const ASYNC_STATE = new Map();
  
  function promiseWithResolvers() {
    if (Promise.withResolvers) {
      return Promise.withResolvers();
    } else {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }
  }
  
  class Waitable {
    #componentIdx;
    
    #pendingEventFn = null;
    
    #promise;
    #resolve;
    #reject;
    
    #waitableSet = null;
    
    #hasSyncWaiter = false;
    
    #idx = null; // to component-global waitables
    
    target;
    
    constructor(args) {
      const { componentIdx, target } = args;
      this.#componentIdx = componentIdx;
      this.target = args.target;
      this.#resetPromise();
    }
    
    componentIdx() { return this.#componentIdx; }
    isInSet() { return this.#waitableSet !== null; }
    
    idx() { return this.#idx; }
    setIdx(idx) {
      if (idx === 0) { throw new Error("waitable idx cannot be zero"); }
      this.#idx = idx;
    }
    
    setTarget(tgt) { this.target = tgt; }
    
    #resetPromise() {
      const { promise, resolve, reject } = promiseWithResolvers()
      this.#promise = promise;
      this.#resolve = resolve;
      this.#reject = reject;
    }
    
    resolve() { this.#resolve(); }
    reject(err) { this.#reject(err); }
    promise() { return this.#promise; }
    
    hasPendingEvent() {
      // _debugLog('[Waitable#hasPendingEvent()]', {
        //     componentIdx: this.#componentIdx,
        //     waitable: this,
        //     waitableSet: this.#waitableSet,
        //     hasPendingEvent: this.#pendingEventFn !== null,
        // });
        return this.#pendingEventFn !== null;
      }
      
      setPendingEvent(fn) {
        _debugLog('[Waitable#setPendingEvent()] args', {
          waitable: this,
          inSet: this.#waitableSet,
        });
        this.#pendingEventFn = fn;
      }
      
      getPendingEvent() {
        _debugLog('[Waitable#getPendingEvent()] args', {
          waitable: this,
          inSet: this.#waitableSet,
          hasPendingEvent: this.#pendingEventFn !== null,
        });
        if (this.#pendingEventFn === null) { return null; }
        const eventFn = this.#pendingEventFn;
        this.#pendingEventFn = null;
        const e = eventFn();
        this.#resetPromise();
        return e;
      }
      
      join(waitableSet) {
        _debugLog('[Waitable#join()] args', {
          waitable: this,
          waitableSet: waitableSet,
          isRemoval: waitableSet === null,
        });
        
        if (this.#waitableSet === undefined) {
          throw new TypeError('waitable set must be not be undefined');
        }
        
        if (this.#waitableSet) {
          this.#waitableSet.removeWaitable(this);
        }
        
        this.#waitableSet = waitableSet;
        
        if (waitableSet) {
          this.#waitableSet.addWaitable(this);
        }
      }
      
      drop() {
        _debugLog('[Waitable#drop()] args', {
          componentIdx: this.#componentIdx,
          waitable: this,
        });
        if (this.hasPendingEvent()) {
          throw new Error('waitables with pending events cannot be dropped');
        }
        this.join(null);
      }
      
      async waitForPendingEvent(args) {
        const { cstate } = args;
        if (!cstate) { throw new TypeError('missing component state'); }
        
        if (this.#waitableSet !== null || this.#hasSyncWaiter) {
          throw new Error("waitable is already in a set/has a sync waiter");
        }
        this.#hasSyncWaiter = true;
        await cstate.waitUntil({
          cancellable: false,
          readyFn: () => this.hasPendingEvent(),
        });
        this.#hasSyncWaiter = false;
      }
      
    }
    const INSTANCE_FLAGS = new Map();
    const STORE_TRAP = { error: null };
    const WebAssemblyRuntimeError = WebAssembly.RuntimeError;
    
    class RepTable {
      // Sentinel marking a freed slot; the freelist link for a freed slot
      // lives in the odd cell. This keeps get()/contains()/remove() on freed
      // reps well-defined (previously they returned/corrupted freelist links).
      static FREE = Symbol('RepTable.free');
      
      #data = [0, null];
      #size = 0;
      #target;
      
      constructor(args) {
        this.target = args?.target;
      }
      
      data() { return this.#data; }
      
      insert(val) {
        _debugLog('[RepTable#insert()] args', { val, target: this.target });
        const freeIdx = this.#data[0];
        if (freeIdx === 0) {
          this.#data.push(val);
          this.#data.push(null);
          const rep = (this.#data.length >> 1) - 1;
          _debugLog('[RepTable#insert()] inserted', { val, target: this.target, rep });
          this.#size += 1;
          return rep;
        }
        const placementIdx = freeIdx << 1;
        if (this.#data[placementIdx] !== RepTable.FREE) {
          throw new Error('corrupt rep table freelist: head does not point at a freed slot');
        }
        this.#data[0] = this.#data[placementIdx + 1];
        this.#data[placementIdx] = val;
        this.#data[placementIdx + 1] = null;
        _debugLog('[RepTable#insert()] inserted', { val, target: this.target, rep: freeIdx });
        this.#size += 1;
        return freeIdx;
      }
      
      get(rep) {
        _debugLog('[RepTable#get()] args', { rep, target: this.target });
        if (rep === 0) { throw new Error('invalid resource rep during get, (cannot be 0)'); }
        
        const baseIdx = rep << 1;
        const val = this.#data[baseIdx];
        if (val === RepTable.FREE) { return undefined; }
        return val;
      }
      
      contains(rep) {
        _debugLog('[RepTable#contains()] args', { rep, target: this.target });
        if (rep === 0) { throw new Error('invalid resource rep during contains, (cannot be 0)'); }
        
        const baseIdx = rep << 1;
        const val = this.#data[baseIdx];
        return val !== RepTable.FREE && !!val;
      }
      
      remove(rep) {
        _debugLog('[RepTable#remove()] args', { rep, target: this.target });
        if (rep === 0) { throw new Error('invalid resource rep during remove, (cannot be 0)'); }
        if (this.#data.length === 2) { throw new Error('invalid'); }
        
        const baseIdx = rep << 1;
        if (baseIdx >= this.#data.length) {
          throw new Error(`invalid rep [${rep}] during remove, out of range`);
        }
        const val = this.#data[baseIdx];
        if (val === RepTable.FREE) {
          throw new Error(`double removal of rep [${rep}] (already freed)`);
        }
        
        this.#data[baseIdx] = RepTable.FREE;
        this.#data[baseIdx + 1] = this.#data[0];
        this.#data[0] = rep;
        this.#size -= 1;
        
        return val;
      }
      
      size() { return this.#size; }
      
      clear() {
        _debugLog('[RepTable#clear()] args', { rep, target: this.target });
        this.#data = [0, null];
      }
    }
    
    class ComponentAsyncState {
      static EVENT_HANDLER_EVENTS = [ 'backpressure-change' ];
      
      static TickResult = {
        // no suspended tasks remain
        DONE: 'done',
        // a suspended task was resumed (more may be ready)
        RESUMED: 'resumed',
        // suspended tasks remain but none were ready
        IDLE: 'idle',
      };
      
      #componentIdx;
      #callingAsyncImport = false;
      #syncImportWait = promiseWithResolvers();
      #lockHolderTaskID = null;
      #lockWaiters = [];
      #lockHandoffScheduled = false;
      #parkedTasks = new Map();
      #suspendedTasksByTaskID = new Map();
      #suspendedTaskIDs = [];
      #errored = null;
      #backpressure = 0;
      #backpressureWaiters = 0n;
      
      #handlerMap = new Map();
      #nextHandlerID = 0n;
      
      #tickLoop = null;
      #tickLoopInterval = null;
      
      #onExclusiveReleaseHandlers = [];
      
      #mayLeave = true;
      
      handles;
      subtasks;
      
      constructor(args) {
        this.#componentIdx = args.componentIdx;
        this.handles = new RepTable({ target: `component [${this.#componentIdx}] handles (waitable objects)` });
        this.subtasks = new RepTable({ target: `component [${this.#componentIdx}] subtasks` });
      };
      
      componentIdx() { return this.#componentIdx; }
      
      get mayLeave() {
        const flags = INSTANCE_FLAGS.get(this.#componentIdx);
        return flags === undefined ? this.#mayLeave : flags.value === 1;
      }
      set mayLeave(value) {
        if (typeof value !== 'boolean') { throw new TypeError('mayLeave must be a boolean'); }
        this.#mayLeave = value;
        const flags = INSTANCE_FLAGS.get(this.#componentIdx);
        if (flags !== undefined) { flags.value = value ? 1 : 0; }
      }
      
      errored() { return this.#errored !== null; }
      setErrored(err) {
        _debugLog('[ComponentAsyncState#setErrored()] component errored', { err, componentIdx: this.#componentIdx });
        if (this.#errored) { return; }
        if (!err) {
          err = new Error('error elswehere (see other component instance error)')
          err.componentIdx = this.#componentIdx;
        }
        this.#errored = err;
      }
      
      markTrapped(err) {
        if (!(err instanceof WebAssemblyRuntimeError)) {
          return false;
        }
        _debugLog('[ComponentAsyncState#markTrapped()] component trapped', { err, componentIdx: this.#componentIdx });
        if (STORE_TRAP.error === null) { STORE_TRAP.error = err; }
        return true;
      }
      
      throwIfTrapped() {
        if (STORE_TRAP.error !== null) { throw STORE_TRAP.error; }
      }
      
      callingSyncImport(val) {
        if (val === undefined) { return this.#callingAsyncImport; }
        if (typeof val !== 'boolean') { throw new TypeError('invalid setting for async import'); }
        const prev = this.#callingAsyncImport;
        this.#callingAsyncImport = val;
        if (prev === true && this.#callingAsyncImport === false) {
          this.#notifySyncImportEnd();
        }
      }
      
      #notifySyncImportEnd() {
        const existing = this.#syncImportWait;
        this.#syncImportWait = promiseWithResolvers();
        existing.resolve();
      }
      
      async waitForSyncImportCallEnd() {
        await this.#syncImportWait.promise;
      }
      
      setBackpressure(v) {
        this.#backpressure = v;
        return this.#backpressure
      }
      getBackpressure() { return this.#backpressure; }
      
      incrementBackpressure() {
        const current = this.#backpressure;
        if (current < 0 || current > 2**16) {
          throw new Error(`invalid current backpressure value [${current}]`);
        }
        const newValue = this.getBackpressure() + 1;
        if (newValue >= 2**16) {
          throw new Error(`invalid new backpressure value [${newValue}], overflow`);
        }
        return this.setBackpressure(newValue);
      }
      
      decrementBackpressure() {
        const current = this.#backpressure;
        if (current < 0 || current > 2**16) {
          throw new Error(`invalid current backpressure value [${current}]`);
        }
        const newValue = Math.max(0, current - 1);
        if (newValue < 0) {
          throw new Error(`invalid new backpressure value [${newValue}], underflow`);
        }
        return this.setBackpressure(newValue);
      }
      hasBackpressure() { return this.#backpressure > 0; }
      
      waitForBackpressure() {
        let backpressureCleared = false;
        const cstate = this;
        cstate.addBackpressureWaiter();
        const handlerID = this.registerHandler({
          event: 'backpressure-change',
          fn: (bp) => {
            if (bp === 0) {
              cstate.removeHandler(handlerID);
              backpressureCleared = true;
            }
          }
        });
        return new Promise((resolve) => {
          const interval = setInterval(() => {
            if (backpressureCleared) { return; }
            clearInterval(interval);
            cstate.removeBackpressureWaiter();
            resolve(null);
          }, 0);
        });
      }
      
      registerHandler(args) {
        const { event, fn } = args;
        if (!event) { throw new Error("missing handler event"); }
        if (!fn) { throw new Error("missing handler fn"); }
        
        if (!ComponentAsyncState.EVENT_HANDLER_EVENTS.includes(event)) {
          throw new Error(`unrecognized event handler [${event}]`);
        }
        
        const handlerID = this.#nextHandlerID++;
        let handlers = this.#handlerMap.get(event);
        if (!handlers) {
          handlers = [];
          this.#handlerMap.set(event, handlers)
        }
        
        handlers.push({ id: handlerID, fn, event });
        return handlerID;
      }
      
      removeHandler(args) {
        const { event, handlerID } = args;
        const registeredHandlers = this.#handlerMap.get(event);
        if (!registeredHandlers) { return; }
        const found = registeredHandlers.find(h => h.id === handlerID);
        if (!found) { return; }
        this.#handlerMap.set(event, this.#handlerMap.get(event).filter(h => h.id !== handlerID));
      }
      
      getBackpressureWaiters() { return this.#backpressureWaiters; }
      addBackpressureWaiter() { this.#backpressureWaiters++; }
      removeBackpressureWaiter() {
        this.#backpressureWaiters--;
        if (this.#backpressureWaiters < 0) {
          throw new Error("unexepctedly negative number of backpressure waiters");
        }
      }
      
      // The per-slice mutual-exclusion lock for guest execution in this
      // component instance. Guest slices (callback invocations and
      // sync-lifted bodies) must be atomic per component even across the
      // JSPI suspensions jco introduces for host imports: wit-bindgen's
      // executors publish per-task state in single linear-memory cells
      // (the wasip3-task pointer, context-local storage discipline) that
      // an interleaved slice of the same component corrupts
      //
      // The lock is *owned*: acquisition records the holder task and
      // release is a no-op for anyone else, so a task exiting can no
      // longer drop a hold it does not own (blind acquire/release-any
      // was the previous discipline). Contended acquisition queues
      // FIFO; release hands the lock to the next waiter directly.
      isExclusivelyLocked() { return this.#lockHolderTaskID !== null; }
      exclusivelyLockedBy(taskID) { return this.#lockHolderTaskID === taskID; }
      
      exclusiveLock(taskID) {
        _debugLog('[ComponentAsyncState#exclusiveLock()]', {
          holder: this.#lockHolderTaskID,
          requester: taskID,
          componentIdx: this.#componentIdx,
        });
        if (taskID === undefined || taskID === null) {
          throw new Error('exclusive lock requires the acquiring task id');
        }
        if (this.#lockHolderTaskID !== null) {
          throw new Error(`component [${this.#componentIdx}] exclusive lock held by task [${this.#lockHolderTaskID}], requested by [${taskID}]`);
        }
        this.#lockHolderTaskID = taskID;
      }
      
      // Awaitable acquisition: takes the lock immediately when free,
      // otherwise queues FIFO behind the current holder and earlier
      // waiters. The resolved promise implies ownership.
      async acquireExclusiveLock(taskID) {
        if (taskID === undefined || taskID === null) {
          throw new Error('exclusive lock requires the acquiring task id');
        }
        if (this.#lockHolderTaskID === null) {
          this.#lockHolderTaskID = taskID;
          _debugLog('[ComponentAsyncState#acquireExclusiveLock()] acquired', {
            holder: taskID,
            componentIdx: this.#componentIdx,
          });
          return;
        }
        if (this.#lockHolderTaskID === taskID) {
          throw new Error(`task [${taskID}] already holds the lock for component [${this.#componentIdx}]`);
        }
        _debugLog('[ComponentAsyncState#acquireExclusiveLock()] waiting', {
          holder: this.#lockHolderTaskID,
          requester: taskID,
          componentIdx: this.#componentIdx,
          queued: this.#lockWaiters.length,
        });
        await new Promise((resolve) => {
          this.#lockWaiters.push({ taskID, resolve });
        });
      }
      
      exclusiveRelease(taskID) {
        _debugLog('[ComponentAsyncState#exclusiveRelease()] args', {
          holder: this.#lockHolderTaskID,
          releaser: taskID,
          componentIdx: this.#componentIdx,
        });
        if (this.#lockHolderTaskID !== taskID) {
          // Ownerless releases were the historical behavior; a foreign
          // release now leaves the hold intact
          _debugLog('[ComponentAsyncState#exclusiveRelease()] ignoring foreign release', {
            holder: this.#lockHolderTaskID,
            releaser: taskID,
            componentIdx: this.#componentIdx,
          });
          return false;
        }
        
        // Make the release observable before handing the lock to the next
        // asynchronous guest slice.
        //
        // Release handlers may expose a lifted value whose consumer immediately
        // performs a synchronous call on the same component; that call must run
        // while the instance is genuinely unlocked, not via enterSync's
        // lock-free fallback code.
        this.#lockHolderTaskID = null;
        
        this.#onExclusiveReleaseHandlers = this.#onExclusiveReleaseHandlers.filter(v => !!v);
        for (const [idx, f] of this.#onExclusiveReleaseHandlers.entries()) {
          try {
            this.#onExclusiveReleaseHandlers[idx] = null;
            f();
          } catch (err) {
            _debugLog("error while executing handler for next exclusive release", err);
            throw err;
          }
        }
        this.#scheduleLockHandoff();
        return true;
      }
      
      #scheduleLockHandoff() {
        if (this.#lockHandoffScheduled || this.#lockWaiters.length === 0) { return; }
        this.#lockHandoffScheduled = true;
        queueMicrotask(() => {
          this.#lockHandoffScheduled = false;
          // A synchronous call triggered by a release handler gets the
          // first opportunity to use the unlocked component.
          //
          // Its release will leave this queued handoff in place.
          if (this.#lockHolderTaskID !== null) {
            this.#scheduleLockHandoff();
            return;
          }
          const next = this.#lockWaiters.shift();
          if (!next) { return; }
          this.#lockHolderTaskID = next.taskID;
          next.resolve();
        });
      }
      
      onNextExclusiveRelease(fn) {
        _debugLog('[ComponentAsyncState#()onNextExclusiveRelease] registering');
        this.#onExclusiveReleaseHandlers.push(fn);
      }
      
      async waitForExclusiveRelease() {
        while (this.isExclusivelyLocked()) {
          await new Promise(resolve => this.onNextExclusiveRelease(resolve));
        }
      }
      
      #getSuspendedTaskMeta(taskID) {
        return this.#suspendedTasksByTaskID.get(taskID);
      }
      
      #removeSuspendedTaskMeta(taskID) {
        _debugLog('[ComponentAsyncState#removeSuspendedTaskMeta()] removing suspended task', {
          taskID,
          componentIdx: this.#componentIdx,
        });
        const idx = this.#suspendedTaskIDs.findIndex(t => t === taskID);
        const meta = this.#suspendedTasksByTaskID.get(taskID);
        this.#suspendedTaskIDs[idx] = null;
        this.#suspendedTasksByTaskID.delete(taskID);
        return meta;
      }
      
      #addSuspendedTaskMeta(meta) {
        if (!meta) { throw new Error('missing task meta'); }
        const taskID = meta.taskID;
        this.#suspendedTasksByTaskID.set(taskID, meta);
        this.#suspendedTaskIDs.push(taskID);
        if (this.#suspendedTasksByTaskID.size < this.#suspendedTaskIDs.length - 10) {
          this.#suspendedTaskIDs = this.#suspendedTaskIDs.filter(t => t !== null);
        }
      }
      
      // TODO(threads): readyFn is normally on the thread
      suspendTask(args) {
        const { task, readyFn } = args;
        const taskID = task.id();
        const componentIdx = task.componentIdx();
        _debugLog('[ComponentAsyncState#suspendTask()]', {
          taskID,
          componentIdx: this.#componentIdx,
          taskEntryFnName: task.entryFnName(),
          subtask: task.getParentSubtask(),
        });
        
        if (componentIdx !== this.#componentIdx) {
          throw new Error('assert: task component idx should match async state');
        }
        
        if (this.#getSuspendedTaskMeta(taskID)) {
          throw new Error(`task [${taskID}] already suspended`);
        }
        
        const { promise, resolve, reject } = promiseWithResolvers();
        this.#addSuspendedTaskMeta({
          task,
          taskID,
          readyFn,
          resume: () => {
            _debugLog('[ComponentAsyncState] resuming suspended task', {
              taskID,
              componentIdx: this.#componentIdx,
            });
            // TODO(threads): it's thread cancellation we should be checking for below, not task
            resolve(!task.isCancelled());
          },
        });
        
        this.runTickLoop();
        
        return promise;
      }
      
      resumeTaskByID(taskID) {
        const meta = this.#removeSuspendedTaskMeta(taskID);
        if (!meta) { return; }
        if (meta.taskID !== taskID) { throw new Error('task ID does not match'); }
        meta.resume();
      }
      
      async runTickLoop() {
        if (this.#tickLoop !== null) { return; }
        this.#tickLoop = 1;
        setTimeout(async () => {
          let result = this.tick();
          while (result !== ComponentAsyncState.TickResult.DONE) {
            // After resuming a task, re-tick as soon as the resumed
            // slice's microtask continuations have drained (timeout 0)
            // so queued sibling resumptions aren't charged the idle
            // polling interval; otherwise poll at the idle cadence.
            const delay = result === ComponentAsyncState.TickResult.RESUMED ? 0 : 10;
            await new Promise((resolve) => setTimeout(resolve, delay));
            result = this.tick();
          }
          this.#tickLoop = null;
        }, 10);
      }
      
      tick() {
        // _debugLog('[ComponentAsyncState#tick()]', { suspendedTaskIDs: this.#suspendedTaskIDs });
        
        const resumableTasks = this.#suspendedTaskIDs.filter(t => t !== null);
        for (const taskID of resumableTasks) {
          const meta = this.#suspendedTasksByTaskID.get(taskID);
          if (!meta || !meta.readyFn) {
            throw new Error(`missing/invalid task despite ID [${taskID}] being present`);
          }
          
          // If the task failed via any means, allow the task to resume because
          // it's been cancelled -- the callback should immediately exit as well
          if (meta.task.isRejected()) {
            _debugLog('[ComponentAsyncState#tick()] detected task rejection, leaving early', { meta });
            this.resumeTaskByID(taskID);
            return ComponentAsyncState.TickResult.RESUMED;
          }
          
          const isReady = meta.readyFn();
          if (!isReady) { continue; }
          
          _debugLog('[ComponentAsyncState#tick()] resuming task via tick', {
            taskID,
            componentIdx: this.#componentIdx,
          });
          this.resumeTaskByID(taskID);
          
          // NOTE: during single-flight resumption, we should resume at most one task per
          // tick so that the resumed slice (a microtask continuation)
          // runs -- and its current-task register window opens and
          // closes -- before any sibling task of this component is
          // resumed.
          //
          // Resuming multiple suspended tasks in one synchronous
          // cascade interleaves their register save/restore windows
          // ([restoreA, restoreB, resumeA, resumeB]), re-entering wasm
          // with the register naming the wrong task, and the
          // 'known residual' of the JSPI current-task register
          // fix); with concurrent task lifetimes per component this
          // corrupts guest context-local storage.
          return ComponentAsyncState.TickResult.RESUMED;
        }
        
        const idle = this.#suspendedTaskIDs.filter(t => t !== null).length > 0;
        return idle
        ? ComponentAsyncState.TickResult.IDLE
        : ComponentAsyncState.TickResult.DONE;
      }
      
      createWaitable(args) {
        return new Waitable({ target: args?.target, });
      }
    }
    
    function getOrCreateAsyncState(componentIdx, init) {
      if (!ASYNC_STATE.has(componentIdx)) {
        const newState = new ComponentAsyncState({ componentIdx });
        ASYNC_STATE.set(componentIdx, newState);
      }
      return ASYNC_STATE.get(componentIdx);
    }
    const GLOBAL_COMPONENT_MEMORY_MAP = new Map();
    
    function lookupMemoriesForComponent(args) {
      const { componentIdx } = args ?? {};
      if (args.componentIdx === undefined) { throw new TypeError("missing component idx"); }
      
      const metas = GLOBAL_COMPONENT_MEMORY_MAP.get(componentIdx);
      if (!metas) { return []; }
      
      if (args.memoryIdx === undefined) {
        return Object.values(metas);
      }
      
      const meta = metas[args.memoryIdx];
      return meta?.memory;
    }
    
    class AsyncSubtask {
      static _ID = 0n;
      
      static State = {
        STARTING: 0,
        STARTED: 1,
        RETURNED: 2,
        CANCELLED_BEFORE_STARTED: 3,
        CANCELLED_BEFORE_RETURNED: 4,
      };
      
      #id;
      #state = AsyncSubtask.State.STARTING;
      #componentIdx;
      
      #parentTask;
      #childTask = null;
      
      #dropped = false;
      #cancelRequested = false;
      
      #memoryIdx = null;
      #lenders = null;
      
      #waitable = null;
      
      #callbackFn = null;
      #callbackFnName = null;
      
      #postReturnFn = null;
      #onProgressFn = null;
      #pendingEventFn = null;
      
      #callMetadata = {};
      
      #resolved = false;
      
      #onResolveHandlers = [];
      #onStartHandlers = [];
      
      #result = null;
      #resultSet = false;
      
      fnName;
      target;
      isAsync;
      isManualAsync;
      
      constructor(args) {
        if (typeof args.componentIdx !== 'number') {
          throw new Error('invalid componentIdx for subtask creation');
        }
        this.#componentIdx = args.componentIdx;
        
        this.#id = ++AsyncSubtask._ID;
        this.fnName = args.fnName;
        
        if (!args.parentTask) { throw new Error('missing parent task during subtask creation'); }
        this.#parentTask = args.parentTask;
        
        if (args.childTask) { this.#childTask = args.childTask; }
        
        if (args.memoryIdx) { this.#memoryIdx = args.memoryIdx; }
        
        if (!args.waitable) { throw new Error("missing/invalid waitable"); }
        this.#waitable = args.waitable;
        
        if (args.callMetadata) { this.#callMetadata = args.callMetadata; }
        
        this.#lenders = [];
        this.target = args.target;
        this.isAsync = args.isAsync;
        this.isManualAsync = args.isManualAsync;
      }
      
      id() { return this.#id; }
      parentTaskID() { return this.#parentTask?.id(); }
      childTaskID() { return this.#childTask?.id(); }
      state() { return this.#state; }
      
      waitable() { return this.#waitable; }
      waitableRep() { return this.#waitable.idx(); }
      
      join() { return this.#waitable.join(...arguments); }
      getPendingEvent() { return this.#waitable.getPendingEvent(...arguments); }
      hasPendingEvent() { return this.#waitable.hasPendingEvent(...arguments); }
      setPendingEvent() { return this.#waitable.setPendingEvent(...arguments); }
      
      setTarget(tgt) { this.target = tgt; }
      
      getResult() {
        if (!this.#resultSet) { throw new Error("subtask result has not been set") }
        return this.#result;
      }
      setResult(v) {
        if (this.#resultSet) { throw new Error("subtask result has already been set"); }
        this.#result = v;
        this.#resultSet = true;
      }
      
      componentIdx() { return this.#componentIdx; }
      
      setChildTask(t) {
        if (!t) { throw new Error('cannot set missing/invalid child task on subtask'); }
        if (this.#childTask) { throw new Error('child task is already set on subtask'); }
        if (this.#parentTask === t) { throw new Error("parent cannot be child"); }
        this.#childTask = t;
      }
      getChildTask(t) { return this.#childTask; }
      
      getParentTask() { return this.#parentTask; }
      
      setCallbackFn(f, name) {
        if (!f) { return; }
        if (this.#callbackFn) { throw new Error('callback fn can only be set once'); }
        this.#callbackFn = f;
        this.#callbackFnName = name;
      }
      
      getCallbackFnName() {
        if (!this.#callbackFn) { return undefined; }
        return this.#callbackFn.name;
      }
      
      setPostReturnFn(f) {
        if (!f) { return; }
        if (this.#postReturnFn) { throw new Error('postReturn fn can only be set once'); }
        this.#postReturnFn = f;
      }
      
      setOnProgressFn(f) {
        if (this.#onProgressFn) { throw new Error('on progress fn can only be set once'); }
        this.#onProgressFn = f;
      }
      
      isNotStarted() {
        return this.#state == AsyncSubtask.State.STARTING;
      }
      
      cancellationRequested() { return this.#cancelRequested; }
      
      // Request cooperative cancellation of this subtask, on behalf of the
      // supertask (i.e. `canon subtask.cancel`).
      //
      // If the callee is another guest task, the request is delivered to it and
      // the callee confirms via `task.cancel` (or still resolves via `task.return`).
      //
      // If the callee is a host function there is (currently) no host-side
      // cancellation hook, so the pending call is treated as immediately
      // cancelled -- consistent with hosts being expected to resolve
      // cancellation promptly -- and any later host resolution is discarded
      // (see `AsyncTask#onResolve`).
      requestCancellation() {
        _debugLog('[AsyncSubtask#requestCancellation()] args', {
          componentIdx: this.#componentIdx,
          subtaskID: this.#id,
          state: this.#state,
          childTaskID: this.childTaskID(),
          fnName: this.fnName,
        });
        if (this.#cancelRequested) {
          throw new Error('cancellation has already been requested for this subtask');
        }
        this.#cancelRequested = true;
        
        if (this.#resolved) { return; }
        
        if (this.#childTask) {
          this.#childTask.requestCancellation();
          return;
        }
        
        this.onResolve(null);
      }
      
      registerOnStartHandler(f) {
        this.#onStartHandlers.push(f);
      }
      
      onStart(args) {
        _debugLog('[AsyncSubtask#onStart()] args', {
          componentIdx: this.#componentIdx,
          subtaskID: this.#id,
          parentTaskID: this.parentTaskID(),
          fnName: this.fnName,
          args,
        });
        
        if (this.#onProgressFn) { this.#onProgressFn(); }
        
        this.#state = AsyncSubtask.State.STARTED;
        
        let result;
        
        // If we have been provided a helper start function as a result of
        // component fusion performed by wasmtime tooling, then we can call that helper and lifts/lowers will
        // be performed for us.
        //
        // See also documentation on `HostIntrinsic::PrepareCall`
        //
        if (this.#callMetadata.startFn) {
          result = this.#callMetadata.startFn.apply(null, args?.startFnParams ?? []);
        }
        
        return result;
      }
      
      
      registerOnResolveHandler(f) {
        this.#onResolveHandlers.push(f);
      }
      
      reject(subtaskErr) {
        if (this.#resolved) { return; }
        
        if (this.#onProgressFn) { this.#onProgressFn(); }
        
        if (this.#state === AsyncSubtask.State.STARTING) {
          this.#state = AsyncSubtask.State.CANCELLED_BEFORE_STARTED;
        } else if (this.#state === AsyncSubtask.State.STARTED) {
          this.#state = AsyncSubtask.State.CANCELLED_BEFORE_RETURNED;
        } else {
          throw new Error('cannot reject a completed subtask');
        }
        
        this.#resolved = true;
        this.#parentTask.removeSubtask(this);
        this.#parentTask.reject(subtaskErr);
      }
      
      onResolve(subtaskValue) {
        _debugLog('[AsyncSubtask#onResolve()] args', {
          componentIdx: this.#componentIdx,
          subtaskID: this.#id,
          isAsync: this.isAsync,
          childTaskID: this.childTaskID(),
          parentTaskID: this.parentTaskID(),
          parentTaskFnName: this.#parentTask?.entryFnName(),
          fnName: this.fnName,
        });
        
        if (this.#resolved) {
          throw new Error('subtask has already been resolved');
        }
        
        if (this.#onProgressFn) { this.#onProgressFn(); }
        
        if (subtaskValue === null && this.#cancelRequested) {
          if (this.#state === AsyncSubtask.State.STARTING) {
            this.#state = AsyncSubtask.State.CANCELLED_BEFORE_STARTED;
          } else {
            if (this.#state !== AsyncSubtask.State.STARTED) {
              throw new Error('resolved subtask must have been started before cancellation');
            }
            this.#state = AsyncSubtask.State.CANCELLED_BEFORE_RETURNED;
          }
        } else {
          if (this.#state !== AsyncSubtask.State.STARTED) {
            throw new Error('resolved subtask must have been started before completion');
          }
          this.#state = AsyncSubtask.State.RETURNED;
        }
        
        this.setResult(subtaskValue);
        
        for (const f of this.#onResolveHandlers) {
          try {
            f(subtaskValue);
          } catch (err) {
            console.error("error during subtask resolve handler", err);
            throw err;
          }
        }
        
        const callMetadata = this.getCallMetadata();
        
        // TODO(fix): we should be able to easily have the caller's meomry
        // to lower into here, but it's not present in PrepareCall
        const memory = callMetadata.memory ?? this.#parentTask?.getReturnMemory() ?? lookupMemoriesForComponent({ componentIdx: this.#parentTask?.componentIdx() })[0];
        // NOTE: cancelled resolutions carry no value, so nothing is lowered
        const returned = this.#state === AsyncSubtask.State.RETURNED;
        if (returned && callMetadata && !callMetadata.returnFn && this.isAsync && callMetadata.resultPtr && memory) {
          const { resultPtr, realloc } = callMetadata;
          const lowers = callMetadata.lowers; // may have been updated in task.return of the child
          if (lowers && lowers.length > 0) {
            lowers[0]({
              componentIdx: this.#componentIdx,
              memory,
              realloc,
              vals: [subtaskValue],
              storagePtr: resultPtr,
              stringEncoding: callMetadata.stringEncoding,
            });
          }
        }
        
        this.#resolved = true;
        this.#parentTask.removeSubtask(this);
        
        if (!this.isAsync) {
          this.deliverResolve();
          const rep = this.waitableRep();
          if (rep) {
            try {
              const removed = this.#getComponentState().handles.remove(rep);
              if (removed !== this) {
                throw new Error("unexpectedly received non-self Subtask from handle removal");
              }
              this.drop();
            } catch (err) {
              _debugLog('[AsyncSubtask#onResolve()] failed to remove subtask after sync subtask completion', err);
            }
          }
        }
      }
      
      getStateNumber() { return this.#state; }
      isReturned() { return this.#state === AsyncSubtask.State.RETURNED; }
      
      getCallMetadata() { return this.#callMetadata; }
      
      isResolved() {
        if (this.#state === AsyncSubtask.State.STARTING
        || this.#state === AsyncSubtask.State.STARTED) {
          return false;
        }
        if (this.#state === AsyncSubtask.State.RETURNED
        || this.#state === AsyncSubtask.State.CANCELLED_BEFORE_STARTED
        || this.#state === AsyncSubtask.State.CANCELLED_BEFORE_RETURNED) {
          return true;
        }
        throw new Error('unrecognized internal Subtask state [' + this.#state + ']');
      }
      
      addLender(handle) {
        _debugLog('[AsyncSubtask#addLender()] args', { handle });
        if (!Number.isNumber(handle)) { throw new Error('missing/invalid lender handle [' + handle + ']'); }
        
        if (this.#lenders.length === 0 || this.isResolved()) {
          throw new Error('subtask has no lendors or has already been resolved');
        }
        
        handle.lends++;
        this.#lenders.push(handle);
      }
      
      deliverResolve() {
        _debugLog('[AsyncSubtask#deliverResolve()] args', {
          lenders: this.#lenders,
          parentTaskID: this.parentTaskID(),
          subtaskID: this.#id,
          childTaskID: this.childTaskID(),
          resolved: this.isResolved(),
          resolveDelivered: this.resolveDelivered(),
        });
        
        const cannotDeliverResolve = this.resolveDelivered() || !this.isResolved();
        if (cannotDeliverResolve) {
          throw new Error('subtask cannot deliver resolution twice, and the subtask must be resolved');
        }
        
        for (const lender of this.#lenders) {
          lender.lends--;
        }
        
        this.#lenders = null;
      }
      
      resolveDelivered() {
        _debugLog('[AsyncSubtask#resolveDelivered()] args', { });
        if (this.#lenders === null && !this.isResolved()) {
          throw new Error('invalid subtask state, lenders missing and subtask has not been resolved');
        }
        return this.#lenders === null;
      }
      
      drop() {
        _debugLog('[AsyncSubtask#drop()] args', {
          componentIdx: this.#componentIdx,
          parentTaskID: this.#parentTask?.id(),
          parentTaskFnName: this.#parentTask?.entryFnName(),
          childTaskID: this.#childTask?.id(),
          childTaskFnName: this.#childTask?.entryFnName(),
          subtaskFnName: this.fnName,
        });
        if (!this.#waitable) { throw new Error('missing/invalid inner waitable'); }
        if (!this.resolveDelivered()) {
          throw new Error('cannot drop subtask before resolve is delivered');
        }
        if (this.#waitable) { this.#waitable.drop() }
        this.#dropped = true;
      }
      
      #getComponentState() {
        const state = getOrCreateAsyncState(this.#componentIdx);
        if (!state) {
          throw new Error('invalid/missing async state for component [' + componentIdx + ']');
        }
        return state;
      }
      
      getWaitableHandleIdx() {
        _debugLog('[AsyncSubtask#getWaitableHandleIdx()] args', { });
        if (!this.#waitable) { throw new Error('missing/invalid waitable'); }
        return this.waitableRep();
      }
    }
    
    class FutureValue {
      #start;
      #settled;
      #hideThen = 0;
      #thenFn;
      
      constructor(start) {
        if (typeof start !== 'function') {
          throw new TypeError('future start operation must be a function');
        }
        this.#start = start;
        this.#thenFn = this.#then.bind(this);
      }
      
      get then() {
        return this.#hideThen === 0 ? this.#thenFn : undefined;
      }
      
      #read() {
        if (!this.#settled) {
          // The start operation resolves to a non-thenable box so a
          // future-valued payload cannot be assimilated by this Promise.
          this.#settled = Promise.resolve().then(this.#start);
        }
        return this.#settled;
      }
      
      resolveAsValue(resolve) {
        this.#hideThen++;
        try {
          resolve(this);
        } finally {
          this.#hideThen--;
        }
      }
      
      #deliver(resolve, value) {
        if (value instanceof FutureValue) {
          // Promise resolution reads `then` synchronously. Hide it only
          // for that lookup so resolving this layer yields the inner
          // FutureValue instead of recursively awaiting it.
          value.resolveAsValue(resolve);
          return;
        }
        resolve(value);
      }
      
      #then(resolve, reject) {
        return this.#read().then(
        box => this.#deliver(resolve, box.value),
        reject,
        );
      }
    }
    const ASYNC_DETERMINISM = 'random';
    const _coinFlip = () => { return Math.random() > 0.5; };
    
    const ASYNC_EVENT_CODE = {
      NONE: 0,
      SUBTASK: 1,
      STREAM_READ: 2,
      STREAM_WRITE: 3,
      FUTURE_READ: 4,
      FUTURE_WRITE: 5,
      TASK_CANCELLED: 6,
    };
    const CURRENT_TASK_META = {};
    
    function _withGlobalCurrentTaskMeta(args) {
      _debugLog('[_withGlobalCurrentTaskMeta()] args', args);
      if (!args) { throw new TypeError('args missing'); }
      if (args.taskID === undefined) { throw new TypeError('missing task ID'); }
      if (args.componentIdx === undefined) { throw new TypeError('missing component idx'); }
      if (!args.fn) { throw new TypeError('missing fn'); }
      const { taskID, componentIdx, fn } = args;
      const previous = CURRENT_TASK_META[componentIdx] ?? null;
      
      try {
        CURRENT_TASK_META[componentIdx] = { taskID, componentIdx };
        return fn();
      } catch (err) {
        _debugLog("error while executing sync callee/callback", {
          ...args,
          err,
        });
        throw err;
      } finally {
        // Synchronous wrappers can nest without any intervening JS
        // scheduling. Restore the caller rather than clearing it so
        // helper core exports (for example fused return adapters) can
        // temporarily run under a different task of the same component.
        CURRENT_TASK_META[componentIdx] = previous;
      }
    }
    
    async function _withGlobalCurrentTaskMetaAsync(args) {
      _debugLog('[_withGlobalCurrentTaskMetaAsync()] args', args);
      if (!args) { throw new TypeError('args missing'); }
      if (args.taskID === undefined) { throw new TypeError('missing task ID'); }
      if (args.componentIdx === undefined) { throw new TypeError('missing component idx'); }
      if (!args.fn) { throw new TypeError('missing fn'); }
      
      const { taskID, componentIdx, fn } = args;
      
      try {
        CURRENT_TASK_META[componentIdx] = { taskID, componentIdx };
        return await fn();
      } catch (err) {
        _debugLog("error while executing async callee/callback", {
          ...args,
          err,
        });
        throw err;
      } finally {
        CURRENT_TASK_META[componentIdx] = null;
      }
    }
    
    class AsyncTask {
      static _ID = 0n;
      
      static State = {
        INITIAL: 'initial',
        CANCELLED: 'cancelled',
        CANCEL_PENDING: 'cancel-pending',
        CANCEL_DELIVERED: 'cancel-delivered',
        RESOLVED: 'resolved',
      }
      
      static BlockResult = {
        CANCELLED: 'block.cancelled',
        NOT_CANCELLED: 'block.not-cancelled',
      }
      
      #id;
      #componentIdx;
      #state;
      #isAsync;
      #isManualAsync;
      #callingWasmExport = true;
      #lockFreeEntry = false;
      #preserveFutureResult;
      #entryFnName = null;
      
      #onResolveHandlers = [];
      #completionPromise = null;
      #rejected = false;
      
      #exitPromise = null;
      #onExitHandlers = [];
      
      #memoryIdx = null;
      #memory = null;
      
      #callbackFn = null;
      #callbackFnName = null;
      
      #postReturnFn = null;
      
      #getCalleeParamsFn = null;
      
      #stringEncoding = null;
      
      #parentSubtask = null;
      
      #errHandling;
      
      #backpressurePromise;
      #backpressureWaiters = 0n;
      
      #returnLowerFns = null;
      
      #subtasks = [];
      
      #entered = false;
      #exited = false;
      #errored = null;
      
      cancelled = false;
      cancelRequested = false;
      alwaysTaskReturn = false;
      
      returnCalls =  0;
      storage = [0, 0];
      borrowedHandles = {};
      
      tmpRetI64HighBits = 0|0;
      
      constructor(opts) {
        this.#id = ++AsyncTask._ID;
        
        if (opts?.componentIdx === undefined) {
          throw new TypeError('missing component id during task creation');
        }
        this.#componentIdx = opts.componentIdx;
        
        this.#state = AsyncTask.State.INITIAL;
        this.#isAsync = opts?.isAsync ?? false;
        this.#isManualAsync = opts?.isManualAsync ?? false;
        this.#preserveFutureResult = opts?.preserveFutureResult ?? false;
        this.#entryFnName = opts.entryFnName;
        // Tasks that execute guest slices (export calls, fused
        // callees) default to true; import-handler tasks pass false
        // explicitly (they run host code nested inside the caller's
        // already-locked slice).
        this.#callingWasmExport = opts?.callingWasmExport !== false;
        
        const {
          promise: completionPromise,
          resolve: resolveCompletionPromise,
          reject: rejectCompletionPromise,
        } = promiseWithResolvers();
        this.#completionPromise = completionPromise;
        // A nested rejection can reach the root task while its Wasm
        // entrypoint is still suspended, before the export wrapper awaits
        // this promise. Mark it handled immediately while preserving the
        // original rejected promise for the eventual caller.
        completionPromise.catch(() => {});
        
        this.#onResolveHandlers.push((results) => {
          if (this.#parentSubtask !== null) { return; }
          if (!this.#isAsync) { return; }
          
          if (this.#errored !== null) {
            rejectCompletionPromise(this.#errored);
            return;
          } else if (this.#rejected) {
            rejectCompletionPromise(results);
            return;
          }
          
          if (this.#preserveFutureResult && results instanceof FutureValue) {
            results.resolveAsValue(resolveCompletionPromise);
          } else {
            resolveCompletionPromise(results);
          }
        });
        
        const {
          promise: exitPromise,
          resolve: resolveExitPromise,
          reject: rejectExitPromise,
        } = promiseWithResolvers();
        this.#exitPromise = exitPromise;
        
        this.#onExitHandlers.push(() => {
          resolveExitPromise();
        });
        
        if (opts.callbackFn) { this.#callbackFn = opts.callbackFn; }
        if (opts.callbackFnName) { this.#callbackFnName = opts.callbackFnName; }
        
        if (opts.getCalleeParamsFn) { this.#getCalleeParamsFn = opts.getCalleeParamsFn; }
        
        if (opts.stringEncoding) { this.#stringEncoding = opts.stringEncoding; }
        
        if (opts.parentSubtask) { this.#parentSubtask = opts.parentSubtask; }
        
        
        if (opts.errHandling) { this.#errHandling = opts.errHandling; }
      }
      
      taskState() { return this.#state; }
      id() { return this.#id; }
      componentIdx() { return this.#componentIdx; }
      entryFnName() { return this.#entryFnName; }
      
      completionPromise() { return this.#completionPromise; }
      exitPromise() { return this.#exitPromise; }
      
      isAsync() { return this.#isAsync; }
      isSync() { return !this.isAsync(); }
      
      getErrHandling() { return this.#errHandling; }
      
      hasCallback() { return this.#callbackFn !== null; }
      
      getReturnMemoryIdx() { return this.#memoryIdx; }
      setReturnMemoryIdx(idx) {
        if (idx === null) { return; }
        this.#memoryIdx = idx;
      }
      
      getReturnMemory() { return this.#memory; }
      setReturnMemory(m) {
        if (m === null) { return; }
        this.#memory = m;
      }
      
      setReturnLowerFns(fns) { this.#returnLowerFns = fns; }
      getReturnLowerFns() { return this.#returnLowerFns; }
      
      setParentSubtask(subtask) {
        if (!subtask || !(subtask instanceof AsyncSubtask)) { return }
        if (this.#parentSubtask) { throw new Error('parent subtask can only be set once'); }
        this.#parentSubtask = subtask;
      }
      
      getParentSubtask() { return this.#parentSubtask; }
      
      // TODO(threads): this is very inefficient, we can pass along a root task,
      // and ideally do not need this once thread support is in place
      getRootTask() {
        let currentSubtask = this.getParentSubtask();
        let task = this;
        while (currentSubtask) {
          task = currentSubtask.getParentTask();
          currentSubtask = task.getParentSubtask();
        }
        return task;
      }
      
      setPostReturnFn(f) {
        if (!f) { return; }
        if (this.#postReturnFn) { throw new Error('postReturn fn can only be set once'); }
        this.#postReturnFn = f;
      }
      
      setCallbackFn(f, name) {
        if (!f) { return; }
        if (this.#callbackFn) { throw new Error('callback fn can only be set once'); }
        this.#callbackFn = f;
        this.#callbackFnName = name;
      }
      
      getCallbackFnName() {
        if (!this.#callbackFnName) { return undefined; }
        return this.#callbackFnName;
      }
      
      async runCallbackFn(...args) {
        if (!this.#callbackFn) { throw new Error('no callback function has been set for task'); }
        return _withGlobalCurrentTaskMetaAsync({
          taskID: this.#id,
          componentIdx: this.#componentIdx,
          fn: () => { return this.#callbackFn.apply(null, args); }
        });
      }
      
      getCalleeParams() {
        if (!this.#getCalleeParamsFn) { throw new Error('missing/invalid getCalleeParamsFn'); }
        return this.#getCalleeParamsFn();
      }
      
      mayBlock() { return this.isAsync() || this.isResolvedState() }
      
      mayEnter(task) {
        const cstate = getOrCreateAsyncState(this.#componentIdx);
        if (cstate.hasBackpressure()) {
          _debugLog('[AsyncTask#mayEnter()] disallowed due to backpressure', { taskID: this.#id });
          return false;
        }
        if (!cstate.callingSyncImport()) {
          _debugLog('[AsyncTask#mayEnter()] disallowed due to sync import call', { taskID: this.#id });
          return false;
        }
        const callingSyncExportWithSyncPending = cstate.callingSyncExport && !task.isAsync;
        if (!callingSyncExportWithSyncPending) {
          _debugLog('[AsyncTask#mayEnter()] disallowed due to sync export w/ sync pending', { taskID: this.#id });
          return false;
        }
        return true;
      }
      
      enterSync() {
        if (this.needsExclusiveLock()) {
          const cstate = getOrCreateAsyncState(this.#componentIdx);
          if (!cstate.isExclusivelyLocked()) {
            cstate.exclusiveLock(this.#id);
          } else {
            // A host-called sync export arriving while another
            // task's slice holds the lock: synchronous entry
            // cannot wait, and historically this entry silently
            // stole the hold. Run without the lock instead --
            // the holder's bookkeeping stays intact and its
            // release still pairs
            this.#lockFreeEntry = true;
            _debugLog('[AsyncTask#enterSync()] entering without exclusive lock', {
              taskID: this.#id,
              componentIdx: this.#componentIdx,
            });
          }
        }
        return true;
      }
      
      async enter(opts) {
        _debugLog('[AsyncTask#enter()] args', {
          taskID: this.#id,
          componentIdx: this.#componentIdx,
          subtaskID: this.getParentSubtask()?.id(),
          args: opts,
          entryFnName: this.#entryFnName,
        });
        
        if (this.#entered) {
          throw new Error(`task with ID [${this.#id}] should not be entered twice`);
        }
        
        // If cancellation was requested before the task was entered, resolve
        // as cancelled without ever running guest code
        if (this.deliverPendingCancel({ cancellable: true })) {
          this.cancel();
          return false;
        }
        
        const cstate = getOrCreateAsyncState(this.#componentIdx);
        
        if (opts?.isHost) {
          this.#entered = true;
          return this.#entered;
        }
        
        // NOTE: concurrent task lifetimes within one component instance are
        // permitted by the Component Model: entry is governed by the
        // backpressure and exclusive-lock checks below (the lock is held per
        // execution slice, not for the task's lifetime).
        //
        // Serializing entire task lifetimes here (the former "execution slot" queue)
        // deadlocks pipelines where a parked long-lived task's progress depends on a
        // later entry into the same component.
        
        // If a task is synchronous then we can avoid component-relevant
        // tracking and immediately enter.
        if (this.isSync()) {
          this.#entered = true;
          
          // TODO(breaking): remove once manually-specifying async fns is removed
          // It is currently possible for an actually sync export to be specified
          // as async via JSPI
          if (this.#isManualAsync) {
            if (this.needsExclusiveLock()) { await cstate.acquireExclusiveLock(this.#id); }
          }
          
          return this.#entered;
        }
        
        // Perform intial backpressure check
        if (cstate.hasBackpressure()) {
          cstate.addBackpressureWaiter();
          
          const result = await this.waitUntil({
            readyFn: () => {
              return !cstate.hasBackpressure();
            },
            cancellable: true,
          });
          
          cstate.removeBackpressureWaiter();
          
          if (result === AsyncTask.BlockResult.CANCELLED) {
            this.cancel();
            return false;
          }
        }
        
        // Acquire the per-slice exclusive lock (FIFO-queued when
        // contended); the first slice runs under this hold and the
        // driver loop releases/re-acquires it per slice thereafter.
        if (this.needsExclusiveLock()) {
          await cstate.acquireExclusiveLock(this.#id);
        }
        
        this.#entered = true;
        return this.#entered;
      }
      
      isRunningState() { return this.#state !== AsyncTask.State.RESOLVED; }
      isResolvedState() { return this.#state === AsyncTask.State.RESOLVED; }
      isResolved() { return this.#state === AsyncTask.State.RESOLVED; }
      isExited() { return this.#exited; }
      
      async waitUntil(opts) {
        const { readyFn, cancellable } = opts;
        _debugLog('[AsyncTask#waitUntil()] args', { taskID: this.#id, args: { cancellable } });
        
        // TODO(fix): check for cancel
        // TODO(fix): determinism
        // TODO(threads): add this thread to waiting list
        
        const keepGoing = await this.suspendUntil({
          readyFn,
          cancellable,
        });
        
        return keepGoing;
      }
      
      async yieldUntil(opts) {
        const { readyFn, cancellable } = opts;
        _debugLog('[AsyncTask#yieldUntil()]', {
          taskID: this.#id,
          args: {
            cancellable,
          },
          componentIdx: this.#componentIdx,
        });
        
        const keepGoing = await this.suspendUntil({ readyFn, cancellable });
        if (keepGoing) {
          return {
            code: ASYNC_EVENT_CODE.NONE,
            payload0: 0,
            payload1: 0,
          };
        }
        
        return {
          code: ASYNC_EVENT_CODE.TASK_CANCELLED,
          payload0: 0,
          payload1: 0,
        };
      }
      
      async suspendUntil(opts) {
        const { cancellable, readyFn } = opts;
        _debugLog('[AsyncTask#suspendUntil()] args', {
          taskID: this.#id,
          args: {
            cancellable,
          },
          componentIdx: this.#componentIdx,
        });
        
        const pendingCancelled = this.deliverPendingCancel({ cancellable });
        if (pendingCancelled) { return false; }
        
        const completed = await this.immediateSuspendUntil({ readyFn, cancellable });
        return completed;
      }
      
      // TODO(threads): equivalent to thread.suspend_until()
      async immediateSuspendUntil(opts) {
        const { cancellable, readyFn } = opts;
        _debugLog('[AsyncTask#immediateSuspendUntil()] args', {
          args: {
            cancellable,
            readyFn,
          },
          taskID: this.#id,
          componentIdx: this.#componentIdx,
        });
        
        const ready = readyFn();
        if (ready && ASYNC_DETERMINISM === 'random') {
          const coinFlip = _coinFlip();
          if (coinFlip) { return true }
        }
        
        const keepGoing = await this.immediateSuspend({ cancellable, readyFn });
        return keepGoing;
      }
      
      async immediateSuspend(opts) { // NOTE: equivalent to thread.suspend()
      // TODO(threads): store readyFn on the thread
      const { cancellable, readyFn } = opts;
      _debugLog('[AsyncTask#immediateSuspend()] args', { cancellable, readyFn });
      
      const pendingCancelled = this.deliverPendingCancel({ cancellable });
      if (pendingCancelled) { return false; }
      
      const cstate = getOrCreateAsyncState(this.#componentIdx);
      const keepGoing = await cstate.suspendTask({
        task: this,
        readyFn: () => {
          // A pending cancellation request wakes cancellable waits
          if (cancellable && this.#state === AsyncTask.State.CANCEL_PENDING) {
            return true;
          }
          return readyFn();
        },
      });
      if (keepGoing && this.deliverPendingCancel({ cancellable })) { return false; }
      return keepGoing;
    }
    
    deliverPendingCancel(opts) {
      const { cancellable } = opts;
      _debugLog('[AsyncTask#deliverPendingCancel()]', {
        args: { cancellable },
        taskID: this.#id,
        componentIdx: this.#componentIdx,
      });
      
      if (cancellable && this.#state === AsyncTask.State.CANCEL_PENDING) {
        this.#state = AsyncTask.State.CANCEL_DELIVERED;
        return true;
      }
      
      return false;
    }
    
    isCancelled() { return this.cancelled }
    
    // Request cooperative cancellation of this task, called on behalf of a
    // supertask performing `subtask.cancel` on the subtask this task backs.
    //
    // The request is delivered at this task's next cancellable wait
    // (see suspendUntil/immediateSuspend), at which point the task is
    // expected to acknowledge via `task.cancel` or still resolve via
    // `task.return`.
    requestCancellation() {
      _debugLog('[AsyncTask#requestCancellation()] args', {
        taskID: this.#id,
        componentIdx: this.#componentIdx,
        state: this.#state,
      });
      if (this.isResolvedState() || this.cancelRequested) { return; }
      this.cancelRequested = true;
      if (this.#state === AsyncTask.State.INITIAL) {
        this.#state = AsyncTask.State.CANCEL_PENDING;
      }
      // Nudge the component's tick loop so that any suspended cancellable
      // wait observes the pending cancellation promptly
      getOrCreateAsyncState(this.#componentIdx).runTickLoop();
    }
    
    cancel(args) {
      _debugLog('[AsyncTask#cancel()] args', { });
      if (this.taskState() !== AsyncTask.State.CANCEL_DELIVERED) {
        throw new Error(`(component [${this.#componentIdx}]) task [${this.#id}] invalid task state [${this.taskState()}] for cancellation`);
      }
      if (this.borrowedHandles.length > 0) { throw new Error('task still has borrow handles'); }
      this.cancelled = true;
      // Cancelled tasks resolve with no value (spec: `Task.cancel` calls
      // `on_resolve(None)`); an explicit error is only present on the
      // host-driven rejection path (see `reject()`).
      this.onResolve(args?.error ?? null);
      this.#state = AsyncTask.State.RESOLVED;
    }
    
    onResolve(taskValue) {
      const handlers = this.#onResolveHandlers;
      this.#onResolveHandlers = [];
      for (const f of handlers) {
        try {
          f(taskValue);
        } catch (err) {
          _debugLog("[AsyncTask#onResolve] error during task resolve handler", err);
          throw err;
        }
      }
      
      // Rejections are control-flow failures, not canonical ABI results.
      // Propagate them through the subtask chain without running return
      // lowering or post-return hooks for a successful result.
      if (this.#rejected) {
        this.#parentSubtask?.reject(taskValue);
        return;
      }
      
      // NOTE: if the parent subtask has already been resolved (e.g. it was
      // cancelled via `subtask.cancel` while this task was still pending),
      // this task's resolution must be discarded rather than delivered.
      const parentSubtaskPending = this.#parentSubtask && !this.#parentSubtask.isResolved();
      
      if (parentSubtaskPending) {
        const meta = this.#parentSubtask.getCallMetadata();
        // Run the rturn fn if it has not already been called -- this *should* have happened in
        // `task.return`, but some paths do not go through task.return (e.g. async lower of sync fn
        // which goes through prepare + async-start-call)
        if (meta.returnFn && !meta.returnFnCalled) {
          _debugLog('[AsyncTask#onResolve()] running returnFn', {
            componentIdx: this.#componentIdx,
            taskID: this.#id,
            subtaskID: this.#parentSubtask.id(),
          });
          const callerTask = this.#parentSubtask.getParentTask();
          _withGlobalCurrentTaskMeta({
            taskID: callerTask.id(),
            componentIdx: callerTask.componentIdx(),
            fn: () => meta.returnFn.apply(null, [taskValue, meta.resultPtr]),
          });
          meta.returnFnCalled = true;
        }
      }
      
      if (this.#postReturnFn) {
        _debugLog('[AsyncTask#onResolve()] running post return ', {
          componentIdx: this.#componentIdx,
          taskID: this.#id,
        });
        try {
          _withGlobalCurrentTaskMeta({
            taskID: this.#id,
            componentIdx: this.#componentIdx,
            fn: () => this.#postReturnFn(taskValue),
          });
        } catch (err) {
          _debugLog("[AsyncTask#onResolve] error during task resolve handler", err);
          throw err;
        }
      }
      
      if (parentSubtaskPending) {
        this.#parentSubtask.onResolve(taskValue);
      }
    }
    
    registerOnResolveHandler(f) {
      this.#onResolveHandlers.push(f);
    }
    
    isRejected() { return this.#rejected; }
    
    isErrored() { return this.#errored; }
    setErrored(err) { this.#errored = err; }
    
    reject(taskErr) {
      _debugLog('[AsyncTask#reject()] args', {
        componentIdx: this.#componentIdx,
        taskID: this.#id,
        parentSubtask: this.#parentSubtask,
        parentSubtaskID: this.#parentSubtask?.id(),
        entryFnName: this.entryFnName(),
        callbackFnName: this.#callbackFnName,
        errMsg: taskErr.message,
      });
      
      if (this.isResolvedState() || this.#rejected) { return; }
      
      this.#rejected = true;
      this.cancelRequested = true;
      this.#state = AsyncTask.State.CANCEL_PENDING;
      const cancelled = this.deliverPendingCancel({ cancellable: true });
      
      // TODO: do cleanup here to reset the machinery so we can run again?
      
      this.cancel({ error: taskErr });
    }
    
    resolve(results) {
      _debugLog('[AsyncTask#resolve()] args', {
        componentIdx: this.#componentIdx,
        taskID: this.#id,
        entryFnName: this.entryFnName(),
        callbackFnName: this.#callbackFnName,
      });
      
      if (this.#state === AsyncTask.State.RESOLVED) {
        throw new Error(`(component [${this.#componentIdx}]) task [${this.#id}]  is already resolved (did you forget to wait for an import?)`);
      }
      
      if (this.borrowedHandles.length > 0) {
        throw new Error('task still has borrow handles');
      }
      
      this.#state = AsyncTask.State.RESOLVED;
      
      switch (results.length) {
        case 0:
        this.onResolve(undefined);
        break;
        case 1:
        this.onResolve(results[0]);
        break;
        default:
        _debugLog('[AsyncTask#resolve()] unexpected number of results', {
          componentIdx: this.#componentIdx,
          results,
          taskID: this.#id,
          subtaskID: this.#parentSubtask?.id(),
          entryFnName: this.#entryFnName,
          callbackFnName: this.#callbackFnName,
        });
        throw new Error('unexpected number of results');
      }
    }
    
    exit(args) {
      _debugLog('[AsyncTask#exit()]', {
        componentIdx: this.#componentIdx,
        taskID: this.#id,
      });
      
      if (this.#exited)  { throw new Error("task has already exited"); }
      
      if (this.#state !== AsyncTask.State.RESOLVED) {
        throw new Error(`(component [${this.#componentIdx}]) task [${this.#id}] exited without resolution`);
      }
      
      if (this.borrowedHandles > 0) {
        throw new Error('task [${this.#id}] exited without clearing borrowed handles');
      }
      
      const state = getOrCreateAsyncState(this.#componentIdx);
      if (!state) { throw new Error('missing async state for component [' + this.#componentIdx + ']'); }
      
      // Exempt the host from exclusive lock check
      if (this.#componentIdx !== -1 && !args?.skipExclusiveLockCheck && !this.#lockFreeEntry) {
        if (this.needsExclusiveLock() && !state.exclusivelyLockedBy(this.#id)) {
          throw new Error(`task [${this.#id}] exit: component [${this.#componentIdx}] should have been exclusively locked by it`);
        }
      }
      
      // Ownership-checked: releases only this task's own hold (a
      // task exiting while another task's slice holds the lock no
      // longer clears the foreign hold).
      state.exclusiveRelease(this.#id);
      
      for (const f of this.#onExitHandlers) {
        try {
          f();
        } catch (err) {
          console.error("error during task exit handler", err);
          throw err;
        }
      }
      
      this.#exited = true;
      clearCurrentTask(this.#componentIdx, this.id());
    }
    
    needsExclusiveLock() {
      // Host (-1) tasks model host-side import handling: there is no
      // guest linear memory or executor state to protect, and host
      // calls from unrelated guest components would contend spuriously.
      if (this.#componentIdx === -1) { return false; }
      // Import-handler tasks (CallInterface) run host code nested
      // inside the calling guest slice, which already holds the
      // lock; only tasks that execute guest slices need it.
      if (!this.#callingWasmExport) { return false; }
      return !this.#isAsync || this.hasCallback();
    }
    
    createSubtask(args) {
      _debugLog('[AsyncTask#createSubtask()] args', args);
      const { componentIdx, childTask, callMetadata, fnName, isAsync, isManualAsync } = args;
      
      const cstate = getOrCreateAsyncState(this.#componentIdx);
      if (!cstate) {
        throw new Error(`invalid/missing async state for component idx [${componentIdx}]`);
      }
      
      const waitable = new Waitable({
        componentIdx: this.#componentIdx,
        target: `subtask (internal ID [${this.#id}])`,
      });
      
      const newSubtask = new AsyncSubtask({
        componentIdx,
        childTask,
        parentTask: this,
        callMetadata,
        isAsync,
        isManualAsync,
        fnName,
        waitable,
      });
      this.#subtasks.push(newSubtask);
      newSubtask.setTarget(`subtask (internal ID [${newSubtask.id()}], waitable [${waitable.idx()}], component [${componentIdx}])`);
      waitable.setIdx(cstate.handles.insert(newSubtask));
      waitable.setTarget(`waitable for subtask (waitable id [${waitable.idx()}], subtask internal ID [${newSubtask.id()}])`);
      return newSubtask;
    }
    
    getLatestSubtask() {
      return this.#subtasks.at(-1);
    }
    
    getSubtaskByWaitableRep(rep) {
      if (rep === undefined) { throw new TypeError('missing rep'); }
      return this.#subtasks.find(s => s.waitableRep() === rep);
    }
    
    currentSubtask() {
      _debugLog('[AsyncTask#currentSubtask()]');
      if (this.#subtasks.length === 0) { return undefined; }
      return this.#subtasks.at(-1);
    }
    
    removeSubtask(subtask) {
      if (this.#subtasks.length === 0) {
        throw new Error('cannot end current subtask: no current subtask');
      }
      this.#subtasks = this.#subtasks.filter(t => t !== subtask);
      return subtask;
    }
  }
  
  function createNewCurrentTask(args) {
    _debugLog('[createNewCurrentTask()] args', args);
    const {
      componentIdx,
      isAsync,
      isManualAsync,
      preserveFutureResult,
      entryFnName,
      parentSubtaskID,
      callbackFnName,
      getCallbackFn,
      getParamsFn,
      stringEncoding,
      errHandling,
      getCalleeParamsFn,
      resultPtr,
      callingWasmExport,
    } = args;
    if (componentIdx === undefined || componentIdx === null) {
      throw new Error('missing/invalid component instance index while starting task');
    }
    let taskMetas = ASYNC_TASKS_BY_COMPONENT_IDX.get(componentIdx);
    const callbackFn = getCallbackFn ? getCallbackFn() : null;
    
    const newTask = new AsyncTask({
      componentIdx,
      isAsync,
      isManualAsync,
      preserveFutureResult,
      entryFnName,
      callbackFn,
      callbackFnName,
      stringEncoding,
      getCalleeParamsFn,
      resultPtr,
      errHandling,
      callingWasmExport,
    });
    
    const newTaskID = newTask.id();
    const newTaskMeta = { id: newTaskID, componentIdx, task: newTask };
    
    // NOTE: do not track host tasks
    ASYNC_CURRENT_TASK_IDS.push(newTaskID);
    ASYNC_CURRENT_COMPONENT_IDXS.push(componentIdx);
    
    if (!taskMetas) {
      taskMetas = [newTaskMeta];
      ASYNC_TASKS_BY_COMPONENT_IDX.set(componentIdx, [newTaskMeta]);
    } else {
      taskMetas.push(newTaskMeta);
    }
    
    return [newTask, newTaskID];
  }
  
  function _checkMayLeave(componentIdx) {
    if (INSTANCE_FLAGS.get(componentIdx)?.value !== 1) {
      throw new WebAssemblyRuntimeError('cannot leave component instance');
    }
  }
  
  function _getGlobalCurrentTaskMeta(componentIdx) {
    if (componentIdx === null || componentIdx === undefined) {
      throw new Error("missing/invalid component idx");
    }
    const v = CURRENT_TASK_META[componentIdx];
    if (v === undefined || v === null) {
      return undefined;
    }
    return { ...v };
  }
  
  
  function _setGlobalCurrentTaskMeta(args) {
    if (!args) { throw new TypeError('args missing'); }
    if (args.taskID === undefined) { throw new TypeError('missing task ID'); }
    if (args.componentIdx === undefined) { throw new TypeError('missing component idx'); }
    const { taskID, componentIdx } = args;
    return CURRENT_TASK_META[componentIdx] = { taskID, componentIdx };
  }
  
  
  async function _clearCurrentTask(args) {
    _debugLog('[_clearCurrentTask()] args', args);
    if (!args) { throw new TypeError('args missing'); }
    if (args.taskID === undefined) { throw new TypeError('missing task ID'); }
    if (args.componentIdx === undefined) { throw new TypeError('missing component idx'); }
    const { taskID, componentIdx } = args;
    
    const meta = CURRENT_TASK_META[componentIdx];
    if (!meta) { throw new Error(`missing current task meta for component idx [${componentIdx}]`); }
    
    if (meta.taskID !== taskID) {
      throw new Error(`task ID [${meta.taskID}] != requested ID [${taskID}]`);
    }
    if (meta.componentIdx !== componentIdx) {
      throw new Error(`component idx [${meta.componentIdx}] != requested idx [${componentIdx}]`);
    }
    
    CURRENT_TASK_META[componentIdx] = null;
  }
  
  function _lowerImportBackwardsCompat(args) {
    const params = [...arguments].slice(1);
    _debugLog('[_lowerImportBackwardsCompat()] args', { args, params });
    const {
      functionIdx,
      componentIdx,
      isAsync,
      isManualAsync,
      paramLiftFns,
      resultLowerFns,
      hasResultPointer,
      funcTypeIsAsync,
      metadata,
      memoryIdx,
      getMemoryFn,
      getReallocFn,
      importFn,
      stringEncoding,
    } = args;
    
    _checkMayLeave(componentIdx);
    
    let meta = _getGlobalCurrentTaskMeta(componentIdx);
    let createdTask;
    
    // Some components depend on initialization logic (i.e. `_initialize` or some such
    // core wasm export) that is embedded in the component, but is not executed or wizer'd
    // away before the transpiled component is attempted to be used.
    //
    // These components execut their initialization logic *when they are imported* in the
    // transpiled context -- so we may get a call to an export that is lowered without going
    // through `CallWasm` or `CallInterface`.
    //
    if (!meta) {
      if (funcTypeIsAsync || (isAsync && !isManualAsync)) {
        throw new Error('p3 async wasm exports cannot use backwards compat auto-task init');
      }
      
      const [newTask, newTaskID] = createNewCurrentTask({
        componentIdx,
        isAsync,
        isManualAsync,
        callingWasmExport: false,
      });
      createdTask = newTask;
      
      // Since we're managing the task creation ourselves we must clear ourselves
      createdTask.registerOnResolveHandler(() => {
        _clearCurrentTask({
          taskID: task.id(),
          componentIdx: task.componentIdx(),
        });
      });
      
      _setGlobalCurrentTaskMeta({
        componentIdx,
        taskID: newTaskID,
      });
      
      meta = _getGlobalCurrentTaskMeta(componentIdx);
    }
    
    const { taskID } = meta;
    
    const taskMeta = getCurrentTask(componentIdx, taskID);
    if (!taskMeta) {
      throw new Error('invalid/missing async task meta');
    }
    
    const task = taskMeta.task;
    if (!task) { throw new Error('invalid/missing async task'); }
    
    const cstate = getOrCreateAsyncState(componentIdx);
    
    if (!task.mayBlock() && funcTypeIsAsync && !isAsync) {
      throw new Error("non async exports cannot synchronously call async functions");
    }
    
    // If there is an existing task, this should be part of a subtask
    const memory = getMemoryFn();
    // Canonical ABI lower appends result storage as a trailing
    // param when async lower has any flat result, or sync lower
    // has more than one flat result.
    const resultPtr = hasResultPointer ? params[params.length - 1] : undefined;
    const subtask = task.createSubtask({
      componentIdx,
      parentTask: task,
      fnName: importFn.fnName,
      isAsync,
      isManualAsync,
      callMetadata: {
        memoryIdx,
        memory,
        realloc: getReallocFn?.(),
        getReallocFn,
        resultPtr,
        lowers: resultLowerFns,
        stringEncoding,
      }
    });
    task.setReturnMemoryIdx(memoryIdx);
    task.setReturnMemory(getMemoryFn());
    
    subtask.onStart();
    
    // If dealing with a sync lowered sync function, we can directly return results
    //
    // TODO(breaking): remove once we get rid of manual async import specification,
    // as func types cannot be detected in that case only (and we don't need that w/ p3)
    if (!isManualAsync && !isAsync && !funcTypeIsAsync) {
      if (createdTask) { createdTask.enterSync(); }
      
      const res = importFn(...params);
      
      // TODO(breaking): remove once we get rid of manual async import specification,
      // as func types cannot be detected in that case only (and we don't need that w/ p3)
      if (!funcTypeIsAsync && !subtask.isReturned()) {
        throw new Error('post-execution subtasks must either be async or returned');
      }
      
      const syncRes = subtask.getResult();
      if (createdTask) { createdTask.resolve([syncRes]); }
      
      return syncRes;
    }
    
    // Sync-lowered async functions requires async behavior because the callee *can* block,
    // but this call must *act* synchronously and return immediately with the result
    // (i.e. not returning until the work is done)
    //
    // TODO(breaking): remove checking for manual async specification here, once we can go p3-only
    //
    if (!isManualAsync && !isAsync && funcTypeIsAsync) {
      const { promise, resolve, reject } = promiseWithResolvers();
      queueMicrotask(async () => {
        try {
          await importFn(...params);
          if (!subtask.isResolved()) {
            await task.suspendUntil({ readyFn: () => subtask.isResolved() });
          }
          resolve(subtask.getResult());
        } catch (err) {
          reject(err);
        }
      });
      return promise;
    }
    
    // NOTE: at this point we know that we are working with an async lowered import
    
    const subtaskState = subtask.getStateNumber();
    if (subtaskState < 0 || subtaskState >= 2**4) {
      throw new Error('invalid subtask state, out of valid range');
    }
    
    subtask.setOnProgressFn(() => {
      subtask.setPendingEvent(() => {
        if (subtask.isResolved()) { subtask.deliverResolve(); }
        const event = {
          code: ASYNC_EVENT_CODE.SUBTASK,
          payload0: subtask.waitableRep(),
          payload1: subtask.getStateNumber(),
        }
        return event;
      });
    });
    
    // This is a hack to maintain backwards compatibility with
    // manually-specified async imports, used in wasm exports that are
    // not actually async (but are specified as so).
    //
    // This is not normal p3 sync behavior but instead anticipating that
    // the caller that is doing manual async will be waiting for a promise that
    // resolves to the *actual* result.
    //
    // TODO(breaking): remove once manually specified async is removed
    //
    // There are a few cases:
    // 1. sync function with async types (e.g. `f: func() -> stream<u32>`)
    // 2. async function with async types (e.g. `f: async func() -> stream<u32>`)
    // 3. async function with sync types (e.g. `f: async func() -> list<u32>`)
    // 4. sync function with non-async types (e.g. `f: func() -> list<u32>`)
    //
    // This hack *only* applies to 4 -- the case where an async JS host function
    // is supplied to a Wasm export which does *not* need to do any async abi
    // lifting/lowering (async ABI did not exist when JSPI integratiton was
    // initially merged to enable asynchronously returning values from the host)
    //
    const requiresManualAsyncResult = !isAsync && !funcTypeIsAsync && isManualAsync;
    let manualAsyncResult;
    if (requiresManualAsyncResult) {
      manualAsyncResult = promiseWithResolvers();
    }
    
    queueMicrotask(async () => {
      try {
        _debugLog('[_lowerImportBackwardsCompat()] calling lowered import', { importFn, params });
        if (createdTask) { await createdTask.enter(); }
        
        const asyncRes = await importFn(...params);
        if (requiresManualAsyncResult) {
          manualAsyncResult.resolve(subtask.getResult());
        }
        
        if (createdTask) { createdTask.resolve([asyncRes]); }
        
        
      } catch (err) {
        _debugLog("[_lowerImportBackwardsCompat()] import fn error:", err);
        if (requiresManualAsyncResult) {
          manualAsyncResult.reject(err);
          return;
        }
        task.setErrored(err);
        task.reject(err);
      }
    });
    
    if (requiresManualAsyncResult) { return manualAsyncResult.promise; }
    
    _debugLog('[_lowerImportBackwardsCompat()] async-lowered import return', {
      fnName: importFn.fnName,
      componentIdx,
      subtaskID: subtask.id(),
      waitableRep: subtask.waitableRep(),
      subtaskState,
      packedResult: Number(subtask.waitableRep()) << 4 | subtaskState,
    });
    
    return Number(subtask.waitableRep()) << 4 | subtaskState;
  }
  
  function _liftFlatU8(ctx) {
    _debugLog('[_liftFlatU8()] args', { ctx });
    let val;
    
    if (ctx.useDirectParams) {
      if (ctx.params.length === 0) { throw new Error('expected at least a single i32 argument'); }
      val = ctx.params[0];
      ctx.params = ctx.params.slice(1);
      return [val, ctx];
    }
    
    if (ctx.storageLen !== undefined && ctx.storageLen < 1) {
      throw new Error(`insufficient storage ([${ctx.storageLen}] bytes) for lift (u8 requires 1 byte)`);
    }
    
    val = new DataView(ctx.memory.buffer).getUint8(ctx.storagePtr, true);
    
    ctx.storagePtr += 1;
    if (ctx.storageLen !== undefined) { ctx.storageLen -= 1; }
    
    return [val, ctx];
  }
  
  
  function _liftFlatU16(ctx) {
    _debugLog('[_liftFlatU16()] args', { ctx });
    let val;
    
    if (ctx.useDirectParams) {
      if (ctx.params.length === 0) { throw new Error('expected at least a single i32 argument'); }
      val = ctx.params[0];
      ctx.params = ctx.params.slice(1);
      return [val, ctx];
    }
    
    if (ctx.storageLen !== undefined && ctx.storageLen < 2) {
      throw new Error(`insufficient storage ([${ctx.storageLen}] bytes) for lift (u16 requires 2 bytes)`);
    }
    
    val = new DataView(ctx.memory.buffer).getUint16(ctx.storagePtr, true);
    
    ctx.storagePtr += 2;
    if (ctx.storageLen !== undefined) { ctx.storageLen -= 2; }
    
    const rem = ctx.storagePtr % 2;
    if (rem !== 0) { ctx.storagePtr += (2 - rem); }
    
    return [val, ctx];
  }
  
  
  function _liftFlatU32(ctx) {
    _debugLog('[_liftFlatU32()] args', { ctx });
    let val;
    
    if (ctx.useDirectParams) {
      if (ctx.params.length === 0) { throw new Error('expected at least a single i34 argument'); }
      // core i32 values arrive as signed numbers
      val = ctx.params[0] >>> 0;
      ctx.params = ctx.params.slice(1);
      return [val, ctx];
    }
    
    if (ctx.storageLen !== undefined && ctx.storageLen < 4) {
      throw new Error(`insufficient storage ([${ctx.storageLen}] bytes) for lift (u32 requires 4 bytes)`);
    }
    val = new DataView(ctx.memory.buffer).getUint32(ctx.storagePtr, true);
    ctx.storagePtr += 4;
    if (ctx.storageLen !== undefined) { ctx.storageLen -= 4; }
    
    return [val, ctx];
  }
  
  
  function _liftFlatStringUTF8(ctx) {
    _debugLog('[_liftFlatStringUTF8()] args', { ctx });
    let val;
    
    if (ctx.useDirectParams) {
      if (ctx.params.length < 2) { throw new Error('expected at least two u32 arguments'); }
      let offset = ctx.params[0];
      if (typeof offset === 'bigint') { offset = Number(offset); }
      if (!Number.isSafeInteger(offset)) { throw new Error('invalid offset'); }
      const len = ctx.params[1];
      if (!Number.isSafeInteger(len)) {  throw new Error('invalid len'); }
      val = TEXT_DECODER_UTF8.decode(new DataView(ctx.memory.buffer, offset, len));
      ctx.params = ctx.params.slice(2);
      return [val, ctx];
    }
    
    const rem = ctx.storagePtr % 4;
    if (rem !== 0) { ctx.storagePtr += (4 - rem); }
    
    const dv = new DataView(ctx.memory.buffer);
    const start = dv.getUint32(ctx.storagePtr, true);
    const codeUnits = dv.getUint32(ctx.storagePtr + 4, true);
    
    val = TEXT_DECODER_UTF8.decode(new Uint8Array(ctx.memory.buffer, start, codeUnits));
    
    ctx.storagePtr += 8;
    if (ctx.storageLen !== undefined) { ctx.storagelen -= 8; }
    
    return [val, ctx];
  }
  
  function _liftFlatStringUTF16(ctx) {
    _debugLog('[_liftFlatStringUTF16()] args', { ctx });
    let val;
    
    if (ctx.useDirectParams) {
      if (ctx.params.length < 2) { throw new Error('expected at least two u32 arguments'); }
      let offset = ctx.params[0];
      if (typeof offset === 'bigint') { offset = Number(offset); }
      if (!Number.isSafeInteger(offset)) {  throw new Error('invalid offset'); }
      const len = ctx.params[1];
      if (!Number.isSafeInteger(len)) {  throw new Error('invalid len'); }
      val = utf16Decoder.decode(new DataView(ctx.memory.buffer, offset, len));
      ctx.params = ctx.params.slice(2);
      return [val, ctx];
    }
    
    const data = new DataView(ctx.memory.buffer)
    const start = data.getUint32(ctx.storagePtr, vals[0], true);
    const codeUnits = data.getUint32(ctx.storagePtr, vals[0] + 4, true);
    val = utf16Decoder.decode(new Uint16Array(ctx.memory.buffer, start, codeUnits));
    ctx.storagePtr = ctx.storagePtr + 2 * codeUnits;
    if (ctx.storageLen !== undefined) { ctx.storageLen = ctx.storageLen - 2 * codeUnits }
    
    return [val, ctx];
  }
  
  function _liftFlatStringAny(ctx) {
    switch (ctx.stringEncoding) {
      case 'utf8':
      return _liftFlatStringUTF8(ctx);
      case 'utf16':
      return _liftFlatStringUTF16(ctx);
      default:
      throw new Error(`missing/unrecognized/unsupported string encoding [${ctx.stringEncoding}]`);
    }
  }
  
  function _liftFlatRecord(meta) {
    const { fieldMetas, size32: recordSize32, align32: recordAlign32 } = meta;
    return function _liftFlatRecordInner(ctx) {
      _debugLog('[_liftFlatRecord()] args', { ctx });
      
      const originalPtr = ctx.storagePtr;
      const res = {};
      for (const [key, liftFn, size32, align32] of fieldMetas) {
        let fieldPtr;
        if (ctx.storagePtr !== undefined) {
          const rem = ctx.storagePtr % align32;
          if (rem !== 0) { ctx.storagePtr += align32 - rem; }
          fieldPtr = ctx.storagePtr;
        }
        
        // A field occupies exactly size32 bytes of the record's
        // flat storage. Capture the remaining storage budget before
        // lifting the field and restore it afterwards: a field's own
        // lift fn may repurpose storageLen internally (e.g. a list
        // sets it to the element-buffer length while reading
        // out-of-line data and never restores it), which would
        // otherwise corrupt the budget the next field sees.
        // See https://github.com/bytecodealliance/jco/issues/1585.
        let fieldLen;
        if (ctx.storageLen !== undefined) { fieldLen = ctx.storageLen; }
        
        let [val, newCtx] = liftFn(ctx);
        res[key] = val;
        ctx = newCtx;
        
        if (fieldPtr !== undefined) {
          ctx.storagePtr = Math.max(ctx.storagePtr, fieldPtr + size32);
        }
        if (fieldLen !== undefined) {
          ctx.storageLen = fieldLen - size32;
        }
      }
      
      if (originalPtr !== undefined) {
        ctx.storagePtr = Math.max(ctx.storagePtr, originalPtr + recordSize32);
      }
      
      if (ctx.storagePtr !== undefined) {
        const rem = ctx.storagePtr % recordAlign32;
        if (rem !== 0) { ctx.storagePtr += recordAlign32 - rem; }
      }
      
      return [res, ctx];
    }
  }
  
  const _liftFlatVariantScratch = new DataView(new ArrayBuffer(8));
  
  function _liftFlatVariant(meta) {
    const {
      caseMetas,
      variantSize32,
      variantAlign32,
      variantPayloadOffset32,
      variantFlatCount,
      variantPayloadFlatTypes,
      isEnum,
    } = meta;
    
    return function _liftFlatVariantInner(ctx) {
      _debugLog('[_liftFlatVariant()] args', { ctx });
      const origUseParams = ctx.useDirectParams;
      
      let caseIdx;
      let liftRes;
      const originalPtr = ctx.storagePtr;
      const numCases =  caseMetas.length;
      if (caseMetas.length < 256) {
        liftRes = _liftFlatU8(ctx);
      } else if (numCases >= 256 && numCases < 65536) {
        liftRes = _liftFlatU16(ctx);
      } else if (numCases >= 65536 && numCases < 4_294_967_296) {
        liftRes = _liftFlatU32(ctx);
      } else {
        throw new Error(`unsupported number of variant cases [${numCases}]`);
      }
      caseIdx = liftRes[0];
      ctx = liftRes[1];
      
      const [
      tag,
      liftFn,
      caseSize32,
      caseAlign32,
      caseFlatCount,
      caseFlatTypes,
      ] = caseMetas[caseIdx];
      
      if (variantPayloadOffset32 === undefined) {
        throw new Error('unexpectedly missing payload offset');
      }
      
      if (originalPtr !== undefined) {
        ctx.storagePtr = originalPtr + variantPayloadOffset32;
      }
      
      let val;
      if (liftFn === null) {
        val = { tag };
        // NOTE: here we need to move past the entire object in memory
        // despite moving to the payload which we now know is missing/unnecessary
        if (originalPtr !== undefined) {
          ctx.storagePtr = originalPtr + variantSize32;
        }
      } else {
        // When lifting from direct params, the payload arrives as the
        // *join* of all case flat representations: each slot whose
        // joined core type differs from the selected case's core type
        // must be reinterpreted before the payload lift
        // (see CanonicalABI `lift_flat_variant`)
        if (ctx.useDirectParams) {
          if (!variantPayloadFlatTypes || !caseFlatTypes) {
            throw new Error('missing variant flat type metadata during direct-param lift');
          }
          const scratch = _liftFlatVariantScratch;
          for (let i = 0; i < caseFlatTypes.length; i++) {
            const have = variantPayloadFlatTypes[i];
            const want = caseFlatTypes[i];
            if (have === want) { continue; }
            const val = ctx.params[i];
            if (have === 'i64' && want === 'i32') {
              ctx.params[i] = Number(BigInt.asIntN(32, val));
            } else if (have === 'i64' && want === 'f32') {
              scratch.setInt32(0, Number(BigInt.asIntN(32, val)), true);
              ctx.params[i] = scratch.getFloat32(0, true);
            } else if (have === 'i64' && want === 'f64') {
              scratch.setBigInt64(0, val, true);
              ctx.params[i] = scratch.getFloat64(0, true);
            } else if (have === 'i32' && want === 'f32') {
              scratch.setInt32(0, val, true);
              ctx.params[i] = scratch.getFloat32(0, true);
            } else {
              throw new Error(`invalid variant payload coercion [${have}] -> [${want}]`);
            }
          }
        }
        
        const [newVal, newCtx] = liftFn(ctx);
        val = { tag, val: newVal };
        ctx = newCtx;
      }
      
      if (origUseParams) {
        if (variantFlatCount === undefined || variantFlatCount === null) {
          _debugLog('[_liftFlatVariant()] variant with unknown flat count', { ctx, meta });
          throw new Error('cannot lift variant with unknown flat count');
        }
        if (caseFlatCount === undefined || caseFlatCount === null) {
          _debugLog('[_liftFlatVariant()] case with unknown flat count', { ctx, meta, case: meta.caseMetas[caseIdx] });
          throw new Error('cannot lift case with unknown flat count');
        }
        // NOTE: enums can be tightly packed and do not have a descriminant
        const remainingPayloadParams = variantFlatCount - caseFlatCount - (isEnum ? 0 : 1);
        if (remainingPayloadParams < 0) {
          throw new Error(`invalid variant flat count metadata`);
        }
        if (ctx.params.length < remainingPayloadParams) {
          throw new Error(`expected at least [${remainingPayloadParams}] remaining variant payload params, but got [${ctx.params.length}]`);
        }
        ctx.params = ctx.params.slice(remainingPayloadParams);
      }
      
      if (ctx.storagePtr !== undefined) {
        const rem = ctx.storagePtr % variantAlign32;
        if (rem !== 0) { ctx.storagePtr += variantAlign32 - rem; }
      }
      
      return [val, ctx];
    }
  }
  
  function _liftFlatList(meta) {
    const { elemLiftFn, elemSize32, elemAlign32, knownLen, typedArray } = meta;
    
    const listValue =
    typedArray === undefined
    ? values => values
    : values => new typedArray(values);
    
    const readValuesAndReset = (ctx, originalPtr, originalLen, dataPtr, len) => {
      if (dataPtr % elemAlign32 !== 0) {
        throw new TypeError(`list pointer [${dataPtr}] is not aligned to ${elemAlign32}`);
      }
      ctx.storagePtr = dataPtr;
      const val = [];
      for (var i = 0; i < len; i++) {
        const elemPtr = dataPtr + i * elemSize32;
        ctx.storagePtr = elemPtr;
        const [res, nextCtx] = elemLiftFn(ctx);
        val.push(res);
        ctx = nextCtx;
        
        ctx.storagePtr = Math.max(ctx.storagePtr, elemPtr + elemSize32);
      }
      if (originalPtr !== null) { ctx.storagePtr = originalPtr; }
      if (originalLen !== null) { ctx.storageLen = originalLen; }
      return [listValue(val), ctx];
    };
    
    return function _liftFlatListInner(ctx) {
      _debugLog('[_liftFlatList()] args', { ctx });
      
      let liftResults;
      if (knownLen !== undefined) { // list with known length
      if (ctx.useDirectParams) {
        _debugLog('memory unexpectedly missing while lifting unknown length list', { ctx });
        liftResults = [listValue(ctx.params.slice(0, knownLen)), ctx];
        ctx.params = ctx.params.slice(knownLen);
      } else { // indirect params
      if (ctx.memory === null) {
        _debugLog('memory unexpectedly missing while lifting known length list', { knownLen, ctx });
        throw new Error(`memory missing while lifting known length (${knownLen}) list`);
      }
      
      const originalLen = ctx.storageLen;
      const originalPtr = ctx.storagePtr;
      
      ctx.storageLen = knownLen * elemSize32;
      liftResults = readValuesAndReset(ctx, null, originalLen, ctx.storagePtr, knownLen);
    }
    
  } else { // unknown length list
  
  if (ctx.useDirectParams) {
    // unknown length list ptr w/ direct params
    const dataPtr = ctx.params[0];
    const len = ctx.params[1];
    ctx.params = ctx.params.slice(2);
    
    ctx.useDirectParams = false;
    const originalPtr = ctx.storagePtr;
    const originalLen = ctx.storageLen;
    ctx.storageLen = len * elemSize32;
    
    liftResults = readValuesAndReset(ctx, originalPtr, originalLen, dataPtr, len);
    
    ctx.useDirectParams = true;
  } else {
    // unknown length list ptr w/ in-memory params
    const originalLen = ctx.storageLen;
    ctx.storageLen = 8;
    
    const dataPtrLiftRes = _liftFlatU32(ctx);
    const dataPtr = dataPtrLiftRes[0];
    ctx = dataPtrLiftRes[1];
    
    const lenLiftRes = _liftFlatU32(ctx);
    const len = lenLiftRes[0];
    ctx = lenLiftRes[1];
    
    const originalPtr = ctx.storagePtr;
    ctx.storagePtr = dataPtr;
    
    ctx.storageLen = len * elemSize32;
    liftResults = readValuesAndReset(ctx, originalPtr, originalLen, dataPtr, len);
  }
}

return liftResults;
}
}

function _liftFlatTuple(meta) {
  const { elemLiftFns, size32: tupleSize32, align32: tupleAlign32 } = meta;
  return function _liftFlatTupleInner(ctx) {
    _debugLog('[_liftFlatTuple()] args', { ctx });
    
    const originalPtr = ctx.storagePtr;
    const val = [];
    for (const [ liftFn, size32, align32 ]  of elemLiftFns) {
      let elemPtr;
      if (ctx.storagePtr !== undefined) {
        const rem = ctx.storagePtr % align32;
        if (rem !== 0) { ctx.storagePtr += align32 - rem; }
        elemPtr = ctx.storagePtr;
      }
      
      // As in _liftFlatRecord: an element occupies exactly size32
      // bytes of the tuple's flat storage, so capture and restore
      // the storage budget around the element lift to stop a
      // field's internal storageLen use (e.g. lists) leaking into
      // the next element.
      // See https://github.com/bytecodealliance/jco/issues/1585.
      let elemLen;
      if (ctx.storageLen !== undefined) { elemLen = ctx.storageLen; }
      
      const [newValue, newCtx] = liftFn(ctx);
      val.push(newValue);
      ctx = newCtx;
      
      if (elemPtr !== undefined) {
        ctx.storagePtr = Math.max(ctx.storagePtr, elemPtr + size32);
      }
      if (elemLen !== undefined) {
        ctx.storageLen = elemLen - size32;
      }
    }
    
    if (originalPtr !== undefined) {
      ctx.storagePtr = Math.max(ctx.storagePtr, originalPtr + tupleSize32);
    }
    
    if (ctx.storagePtr !== undefined) {
      const rem = ctx.storagePtr % tupleAlign32;
      if (rem !== 0) { ctx.storagePtr += tupleAlign32 - rem; }
    }
    
    return [val, ctx];
  }
}

function _liftFlatEnum(meta) {
  meta.isEnum = true;
  const f = _liftFlatVariant(meta);
  return function _liftFlatEnumInner(ctx) {
    _debugLog('[_liftFlatEnum()] args', { ctx });
    const res = f(ctx);
    res[0] = res[0].tag;
    return res;
  }
}

function _liftFlatOption(meta) {
  const f = _liftFlatVariant(meta);
  return function _liftFlatOptionInner(ctx) {
    _debugLog('[_liftFlatOption()] args', { ctx });
    return f(ctx);
  }
}

function _liftFlatResult(meta) {
  const f = _liftFlatVariant(meta);
  return function _liftFlatResultInner(ctx) {
    _debugLog('[_liftFlatResult()] args', { ctx });
    return f(ctx);
  }
}

function _liftFlatBorrow(componentTableIdx, size, memory, vals, storagePtr, storageLen) {
  _debugLog('[_liftFlatBorrow()] args', { size, memory, vals, storagePtr, storageLen });
  throw new Error('flat lift for borrowed resources is not supported!');
}


function _lowerFlatU8(ctx) {
  _debugLog('[_lowerFlatU8()] args', ctx);
  
  if (ctx.vals.length !== 1) {
    throw new Error(`unexpected number [${ctx.vals.length}] of vals (expected 1)`);
  }
  
  _requireValidNumericPrimitive.bind('u8', ctx.vals[0]);
  
  if (!ctx.memory) { throw new Error("missing memory for lower"); }
  new DataView(ctx.memory.buffer).setUint8(ctx.storagePtr, ctx.vals[0]);
  
  ctx.storagePtr += 1;
}

function _lowerFlatU16(ctx) {
  _debugLog('[_lowerFlatU16()] args', { ctx });
  
  if (!ctx.memory) { throw new Error("missing memory for lower"); }
  if (ctx.vals.length !== 1) {
    throw new Error(`unexpected number [${ctx.vals.length}] of vals (expected 1)`);
  }
  
  const rem = ctx.storagePtr % 2;
  if (rem !== 0) { ctx.storagePtr += (2 - rem); }
  
  _requireValidNumericPrimitive.bind('u16', ctx.vals[0]);
  new DataView(ctx.memory.buffer).setUint16(ctx.storagePtr, ctx.vals[0], true);
  
  ctx.storagePtr += 2;
}

function _lowerFlatU32(ctx) {
  _debugLog('[_lowerFlatU32()] args', { ctx });
  
  if (ctx.vals.length !== 1) {
    throw new Error(`expected single value to lower, got [${ctx.vals.length}]`);
  }
  
  const rem = ctx.storagePtr % 4;
  if (rem !== 0) { ctx.storagePtr += (4 - rem); }
  
  _requireValidNumericPrimitive.bind('u32', ctx.vals[0]);
  new DataView(ctx.memory.buffer).setUint32(ctx.storagePtr, ctx.vals[0], true);
  
  ctx.storagePtr += 4;
}

function _lowerFlatU64(ctx) {
  _debugLog('[_lowerFlatU64()] args', { ctx });
  
  if (ctx.vals.length !== 1) { throw new Error('unexpected number of vals'); }
  
  const rem = ctx.storagePtr % 8;
  if (rem !== 0) { ctx.storagePtr += (8 - rem); }
  
  _requireValidNumericPrimitive.bind('u64', ctx.vals[0]);
  new DataView(ctx.memory.buffer).setBigUint64(ctx.storagePtr, ctx.vals[0], true);
  
  ctx.storagePtr += 8;
}

function _lowerFlatStringUTF8(ctx) {
  _debugLog('[_lowerFlatStringUTF8()] args', ctx);
  if (!ctx.realloc) { throw new Error('missing realloc during flat string lower'); }
  
  const { ptr, len } = _utf8AllocateAndEncode(ctx.vals[0], ctx.realloc, ctx.memory);
  
  const view = new DataView(ctx.memory.buffer);
  view.setUint32(ctx.storagePtr, ptr, true);
  view.setUint32(ctx.storagePtr + 4, len, true);
  
  ctx.storagePtr += 8;
}

function _lowerFlatStringUTF16(ctx) {
  _debugLog('[_lowerFlatStringUTF16()] args', { ctx });
  if (!ctx.realloc) { throw new Error('missing realloc during flat string lower'); }
  
  const { ptr, len } = _utf16AllocateAndEncode(ctx.vals[0], ctx.realloc, ctx.memory);
  
  const view = new DataView(ctx.memory.buffer);
  view.setUint32(ctx.storagePtr, ptr, true);
  view.setUint32(ctx.storagePtr + 4, len, true);
  
  ctx.storagePtr += 8;
}

function _lowerFlatStringAny(ctx) {
  switch (ctx.stringEncoding) {
    case 'utf8':
    return _lowerFlatStringUTF8(ctx);
    case 'utf16':
    return _lowerFlatStringUTF16(ctx);
    default:
    throw new Error(`missing/unrecognized/unsupported string encoding [${ctx.stringEncoding}]`);
  }
}

function _lowerFlatRecord(meta) {
  const { fieldMetas, size32: recordSize32, align32: recordAlign32 } = meta;
  return function _lowerFlatRecordInner(ctx) {
    _debugLog('[_lowerFlatRecord()] args', { ctx });
    
    const originalPtr = ctx.storagePtr;
    const r = ctx.vals[0];
    for (const [tag, lowerFn, size32, align32 ] of fieldMetas) {
      const rem = ctx.storagePtr % align32;
      if (rem !== 0) { ctx.storagePtr += align32 - rem; }
      
      const fieldPtr = ctx.storagePtr;
      ctx.vals = [r[tag]];
      lowerFn(ctx);
      
      ctx.storagePtr = Math.max(ctx.storagePtr, fieldPtr + size32);
    }
    
    ctx.storagePtr = Math.max(ctx.storagePtr, originalPtr + recordSize32);
    
    const rem = ctx.storagePtr % recordAlign32;
    if (rem !== 0) {
      ctx.storagePtr += recordAlign32 - rem;
    }
  }
}

function _lowerFlatVariant(meta) {
  const { variantSize32, variantAlign32, variantPayloadOffset32, caseMetas } = meta;
  
  let caseLookup = {};
  for (const [idx, meta] of caseMetas.entries()) {
    let tag = meta[0];
    caseLookup[tag] = { discriminant: idx, meta };
  }
  
  return function _lowerFlatVariantInner(ctx) {
    _debugLog('[_lowerFlatVariant()] args', { ctx });
    
    const { tag, val } = ctx.vals[0];
    const variantCase = caseLookup[tag];
    if (!variantCase) {
      throw new Error(`missing tag [${tag}] (valid tags: ${Object.keys(caseLookup)})`);
    }
    
    const [ _tag, lowerFn, caseSize32, caseAlign32, caseFlatCount ] = variantCase.meta;
    
    const originalPtr = ctx.storagePtr;
    ctx.vals = [variantCase.discriminant];
    let discLowerRes;
    if (caseMetas.length < 256) {
      discLowerRes = _lowerFlatU8(ctx);
    } else if (caseMetas.length >= 256 && caseMetas.length < 65536) {
      discLowerRes = _lowerFlatU16(ctx);
    } else if (caseMetas.length >= 65536 && caseMetas.length < 4_294_967_296) {
      discLowerRes = _lowerFlatU32(ctx);
    } else {
      throw new Error(`unsupported number of cases [${caseMetas.length}]`);
    }
    
    const payloadOffsetPtr = originalPtr + variantPayloadOffset32;
    ctx.storagePtr = payloadOffsetPtr;
    ctx.vals = [val];
    if (lowerFn) { lowerFn(ctx); }
    
    ctx.storagePtr = Math.max(ctx.storagePtr, originalPtr + variantSize32);
    
    const rem = ctx.storagePtr % variantAlign32;
    if (rem !== 0) { ctx.storagePtr += variantAlign32 - rem; }
  }
}

function _lowerFlatList(meta) {
  const {
    elemLowerFn,
    knownLen,
    size32,
    align32,
    elemSize32,
    elemAlign32,
  } = meta;
  
  if (!elemLowerFn) { throw new TypeError("missing/invalid element lower fn for list"); }
  
  return function _lowerFlatListInner(ctx) {
    _debugLog('[_lowerFlatList()] args', { ctx });
    
    if (ctx.useDirectParams) {
      if (ctx.params.length < 2) { throw new Error('insufficient params left to lower list'); }
      const storagePtr = ctx.params[0];
      const elemCount = ctx.params[1];
      ctx.params = ctx.params.slice(2);
      
      const list = ctx.vals[0];
      if (!list) { throw new Error("missing direct param value"); }
      
      const lowerCtx = {
        storagePtr,
        memory: ctx.memory,
        stringEncoding: ctx.stringEncoding,
      };
      for (let idx = 0; idx < list.length; idx++) {
        const elemPtr = storagePtr + idx * elemSize32;
        lowerCtx.storagePtr = elemPtr;
        lowerCtx.vals = list.slice(idx, idx+1);
        elemLowerFn(lowerCtx);
        lowerCtx.storagePtr = Math.max(lowerCtx.storagePtr, elemPtr + elemSize32);
      }
      ctx.storagePtr = lowerCtx.storagePtr;
      
      // TODO: implement parma-only known-length processing
      
      return;
    }
    
    // TODO(fix): is it possible to get a vals that are a addr and length here from
    // a component lower?
    
    const elems = ctx.vals[0];
    if (knownLen === undefined) {
      // unknown length
      if (!ctx.realloc) { throw new Error('missing realloc during flat string lower'); }
      const dataPtr = ctx.realloc(0, 0, elemAlign32, elemSize32 * elems.length);
      
      ctx.vals[0] = dataPtr;
      _lowerFlatU32(ctx);
      
      ctx.vals[0] = elems.length;
      _lowerFlatU32(ctx);
      
      const origPtr = ctx.storagePtr;
      ctx.storagePtr = dataPtr;
      
      for (const [idx, elem] of elems.entries()) {
        const elemPtr = dataPtr + idx * elemSize32;
        ctx.storagePtr = elemPtr;
        ctx.vals = [elem];
        elemLowerFn(ctx);
        ctx.storagePtr = Math.max(ctx.storagePtr, elemPtr + elemSize32);
      }
      
      ctx.storagePtr = origPtr;
      
    } else {
      // known length
      
      if (elems.length !== knownLen) {
        throw new TypeError(`invalid list input of length [${elems.length}], must be length [${knownLen}]`);
      }
      
      const originalPtr = ctx.storagePtr;
      for (const [idx, elem] of elems.entries()) {
        const elemPtr = originalPtr + idx * elemSize32;
        ctx.storagePtr = elemPtr;
        ctx.vals = [elem];
        elemLowerFn(ctx);
        ctx.storagePtr = Math.max(ctx.storagePtr, elemPtr + elemSize32);
      }
    }
    
    // TODO(fix): special case for u8/u16/etc, we can do a direct copy
    
    const totalSizeBytes = elems.length * size32;
    if (ctx.storageLen !== undefined && totalSizeBytes > ctx.storageLen) {
      throw new Error('not enough storage remaining for list flat lower');
    }
  }
}

function _lowerFlatTuple(meta) {
  const { elemLowerMetas, size32: tupleSize32, align32: tupleAlign32 } = meta;
  return function _lowerFlatTupleInner(ctx) {
    _debugLog('[_lowerFlatTuple()] args', { ctx });
    const originalPtr = ctx.storagePtr;
    const tuple = ctx.vals[0];
    for (const [idx, [ lowerFn, size32, align32 ]]  of elemLowerMetas.entries()) {
      const rem = ctx.storagePtr % align32;
      if (rem !== 0) { ctx.storagePtr += align32 - rem; }
      
      const elemPtr = ctx.storagePtr;
      ctx.vals = [tuple[idx]];
      lowerFn(ctx);
      ctx.storagePtr = Math.max(ctx.storagePtr, elemPtr + size32);
    }
    
    ctx.storagePtr = Math.max(ctx.storagePtr, originalPtr + tupleSize32);
    
    const rem = ctx.storagePtr % tupleAlign32;
    if (rem !== 0) {
      ctx.storagePtr += tupleAlign32 - rem;
    }
  }
}

function _lowerFlatOption(meta) {
  const f = _lowerFlatVariant(meta);
  return function _lowerFlatOptionInner(ctx) {
    _debugLog('[_lowerFlatOption()] args', { ctx });
    
    const v = ctx.vals[0];
    if (v === null || v === undefined) {
      ctx.vals[0] = { tag: 'none' };
    } else {
      const isNotOptionObject = typeof v !== 'object'
      || Object.keys(v).length !== 2
      || !('tag' in v)
      || !(v.tag === 'some' || v.tag === 'none')
      || !('val' in v);
      if (isNotOptionObject) {
        ctx.vals[0] = { tag: 'some', val: v };
      }
    }
    
    f(ctx);
  }
}

function _lowerFlatResult(meta) {
  const f = _lowerFlatVariant(meta);
  return function _lowerFlatResultInner(ctx) {
    _debugLog('[_lowerFlatResult()] args', { ctx });
    
    const v = ctx.vals[0];
    const isNotResultObject = typeof v !== 'object'
    || Object.keys(v).length !== 2
    || !('tag' in v)
    || !('ok' === v.tag || 'err' === v.tag)
    || !('val' in v);
    if (isNotResultObject) {
      ctx.vals[0] = { tag: 'ok', val: v };
    }
    
    f(ctx);
  };
}

function _lowerFlatOwn(meta) {
  const { lowerFn, componentIdx } = meta;
  
  return function _lowerFlatOwnInner(ctx) {
    _debugLog('[_lowerFlatOwn()] args', { ctx });
    const { createFn } = ctx;
    
    if (ctx.componentIdx !== componentIdx) {
      throw new Error(`component index mismatch (expected [${componentIdx}], lift called from [${ctx.componentIdx}])`);
    }
    
    const obj = ctx.vals[0];
    if (obj === undefined || obj === null) { throw new Error('missing resource'); }
    const handle = lowerFn(obj);
    
    ctx.vals[0] = handle;
    _lowerFlatU32(ctx);
  };
}

function _guardMayLeave(componentIdx, fn) {
  return function (...args) {
    _checkMayLeave(componentIdx);
    return fn.apply(this, args);
  };
}

const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;
let _fs;
async function fetchCompile (url) {
  if (isNode) {
    _fs = _fs || await import('node:fs/promises');
    return WebAssembly.compile(await _fs.readFile(url));
  }
  return fetch(url).then(WebAssembly.compileStreaming);
}

const symbolCabiDispose = Symbol.for('cabiDispose');

const symbolRscHandle = Symbol('handle');

const symbolRscRep = Symbol.for('cabiRep');
const symbolDispose = Symbol.dispose || Symbol.for('dispose');

const HANDLE_TABLES= [];


class ComponentError extends Error {
  constructor (value) {
    const enumerable = typeof value !== 'string';
    super(enumerable ? `${String(value)} (see error.payload)` : value);
    Object.defineProperty(this, 'payload', { value, enumerable });
  }
}

const hasOwnProperty = Object.prototype.hasOwnProperty;

function getErrorPayload(e) {
  if (e && hasOwnProperty.call(e, 'payload')) return e.payload;
  if (e instanceof Error) throw e;
  return e;
}

function _suspendingImport(componentIdx, fn) {
  return async function (...args) {
    _checkMayLeave(componentIdx);
    const saved = CURRENT_TASK_META[componentIdx] ?? null;
    try {
      return await fn.apply(null, args);
    } finally {
      CURRENT_TASK_META[componentIdx] = saved;
    }
  };
}


if (!getCoreModule) getCoreModule = (name) => fetchCompile(new URL(`./${name}`, import.meta.url));
const module0 = getCoreModule('gate_contract.core.wasm');
const module1 = getCoreModule('gate_contract.core2.wasm');
const module2 = getCoreModule('gate_contract.core3.wasm');

const { call: call$1 } = imports['host:interfaces/http'];

if (call$1=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'call$1', was 'call' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { call } = imports['host:interfaces/http-with-placeholders'];

if (call=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'call', was 'call' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { get, put } = imports['host:interfaces/kv-store'];

if (get=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'get', was 'get' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}


if (put=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'put', was 'put' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { info } = imports['host:interfaces/logging'];

if (info=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'info', was 'info' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { clusterTimestampSecs, tenantDid } = imports['host:tenant/tenant-context'];

if (clusterTimestampSecs=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'clusterTimestampSecs', was 'clusterTimestampSecs' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}


if (tenantDid=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'tenantDid', was 'tenantDid' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { getEnvironment } = imports['wasi:cli/environment'];

if (getEnvironment=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'getEnvironment', was 'getEnvironment' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { exit } = imports['wasi:cli/exit'];

if (exit=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'exit', was 'exit' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { getStderr } = imports['wasi:cli/stderr'];

if (getStderr=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'getStderr', was 'getStderr' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { getStdin } = imports['wasi:cli/stdin'];

if (getStdin=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'getStdin', was 'getStdin' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { getStdout } = imports['wasi:cli/stdout'];

if (getStdout=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'getStdout', was 'getStdout' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { TerminalInput } = imports['wasi:cli/terminal-input'];

if (TerminalInput=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'TerminalInput', was 'TerminalInput' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { TerminalOutput } = imports['wasi:cli/terminal-output'];

if (TerminalOutput=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'TerminalOutput', was 'TerminalOutput' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { getTerminalStderr } = imports['wasi:cli/terminal-stderr'];

if (getTerminalStderr=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'getTerminalStderr', was 'getTerminalStderr' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { getTerminalStdin } = imports['wasi:cli/terminal-stdin'];

if (getTerminalStdin=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'getTerminalStdin', was 'getTerminalStdin' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { getTerminalStdout } = imports['wasi:cli/terminal-stdout'];

if (getTerminalStdout=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'getTerminalStdout', was 'getTerminalStdout' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { Error: Error$1 } = imports['wasi:io/error'];

if (Error$1=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'Error$1', was 'Error' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { Pollable } = imports['wasi:io/poll'];

if (Pollable=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'Pollable', was 'Pollable' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { InputStream, OutputStream } = imports['wasi:io/streams'];

if (InputStream=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'InputStream', was 'InputStream' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}


if (OutputStream=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'OutputStream', was 'OutputStream' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

let gen = (function* _initGenerator () {
  const instanceFlags0 = new WebAssembly.Global({ value: "i32", mutable: true }, 1);
  INSTANCE_FLAGS.set(0, instanceFlags0);
  let exports0;
  
  const _trampoline0 = function() {
    _debugLog('[iface="host:tenant/tenant-context@1.0.0", function="cluster-timestamp-secs"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'clusterTimestampSecs',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => clusterTimestampSecs(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    _debugLog('[iface="host:tenant/tenant-context@1.0.0", function="cluster-timestamp-secs"][Instruction::Return]', {
      funcName: 'cluster-timestamp-secs',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([toUint64(ret)]);
    task.exit();
    return toUint64(ret);
  }
  _trampoline0.fnName = 'host:tenant/tenant-context@1.0.0#clusterTimestampSecs';
  
  const _trampoline7 = function(arg0) {
    let variant0;
    switch (arg0) {
      case 0: {
        variant0= {
          tag: 'ok',
          val: undefined
        };
        break;
      }
      case 1: {
        variant0= {
          tag: 'err',
          val: undefined
        };
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for expected');
      }
    }
    _debugLog('[iface="wasi:cli/exit@0.2.6", function="exit"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'exit',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => exit(variant0),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    _debugLog('[iface="wasi:cli/exit@0.2.6", function="exit"][Instruction::Return]', {
      funcName: 'exit',
      paramCount: 0,
      async: false,
      postReturn: false
    });
    task.resolve([ret]);
    task.exit();
  }
  _trampoline7.fnName = 'wasi:cli/exit@0.2.6#exit';
  
  const handleTable0 = [T_FLAG, 0];
  handleTable0._createdReps = new Set();
  
  
  const captureTable0= new Map();
  let captureCnt0= 0;
  
  HANDLE_TABLES[0] = handleTable0;
  
  const _trampoline8 = function(arg0) {
    var handle1 = arg0;
    
    var rep2 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable0.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(Pollable.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="wasi:io/poll@0.2.6", function="[method]pollable.block"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'block',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.block(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const entry of curResourceBorrows) {
      const rsc = entry.rsc ?? entry;
      if (entry.drop) {
        if (rsc[symbolRscHandle]) {
          entry.drop(rsc[symbolRscHandle]);
        }
      }
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    _debugLog('[iface="wasi:io/poll@0.2.6", function="[method]pollable.block"][Instruction::Return]', {
      funcName: '[method]pollable.block',
      paramCount: 0,
      async: false,
      postReturn: false
    });
    task.resolve([ret]);
    task.exit();
  }
  _trampoline8.fnName = 'wasi:io/poll@0.2.6#block';
  
  const handleTable3 = [T_FLAG, 0];
  handleTable3._createdReps = new Set();
  
  
  const captureTable3= new Map();
  let captureCnt3= 0;
  
  HANDLE_TABLES[3] = handleTable3;
  
  const _trampoline9 = function(arg0) {
    var handle1 = arg0;
    
    var rep2 = handleTable3[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable3.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(OutputStream.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]output-stream.subscribe"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'subscribe',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.subscribe(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const entry of curResourceBorrows) {
      const rsc = entry.rsc ?? entry;
      if (entry.drop) {
        if (rsc[symbolRscHandle]) {
          entry.drop(rsc[symbolRscHandle]);
        }
      }
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    
    if (!(ret instanceof Pollable)) {
      throw new TypeError('Resource error: Not a valid \"Pollable\" resource.');
    }
    var handle3 = ret[symbolRscHandle];
    if (!handle3) {
      const rep = ret[symbolRscRep] || ++captureCnt0;
      captureTable0.set(rep, ret);
      handle3 = rscTableCreateOwn(handleTable0, rep);
    }
    
    _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]output-stream.subscribe"][Instruction::Return]', {
      funcName: '[method]output-stream.subscribe',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([handle3]);
    task.exit();
    return handle3;
  }
  _trampoline9.fnName = 'wasi:io/streams@0.2.6#subscribe';
  
  const handleTable2 = [T_FLAG, 0];
  handleTable2._createdReps = new Set();
  
  
  const captureTable2= new Map();
  let captureCnt2= 0;
  
  HANDLE_TABLES[2] = handleTable2;
  
  const _trampoline10 = function() {
    _debugLog('[iface="wasi:cli/stdin@0.2.6", function="get-stdin"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'getStdin',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => getStdin(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    
    if (!(ret instanceof InputStream)) {
      throw new TypeError('Resource error: Not a valid \"InputStream\" resource.');
    }
    var handle0 = ret[symbolRscHandle];
    if (!handle0) {
      const rep = ret[symbolRscRep] || ++captureCnt2;
      captureTable2.set(rep, ret);
      handle0 = rscTableCreateOwn(handleTable2, rep);
    }
    
    _debugLog('[iface="wasi:cli/stdin@0.2.6", function="get-stdin"][Instruction::Return]', {
      funcName: 'get-stdin',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([handle0]);
    task.exit();
    return handle0;
  }
  _trampoline10.fnName = 'wasi:cli/stdin@0.2.6#getStdin';
  
  const _trampoline11 = function() {
    _debugLog('[iface="wasi:cli/stdout@0.2.6", function="get-stdout"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'getStdout',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => getStdout(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    
    if (!(ret instanceof OutputStream)) {
      throw new TypeError('Resource error: Not a valid \"OutputStream\" resource.');
    }
    var handle0 = ret[symbolRscHandle];
    if (!handle0) {
      const rep = ret[symbolRscRep] || ++captureCnt3;
      captureTable3.set(rep, ret);
      handle0 = rscTableCreateOwn(handleTable3, rep);
    }
    
    _debugLog('[iface="wasi:cli/stdout@0.2.6", function="get-stdout"][Instruction::Return]', {
      funcName: 'get-stdout',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([handle0]);
    task.exit();
    return handle0;
  }
  _trampoline11.fnName = 'wasi:cli/stdout@0.2.6#getStdout';
  
  const _trampoline12 = function() {
    _debugLog('[iface="wasi:cli/stderr@0.2.6", function="get-stderr"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'getStderr',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => getStderr(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    
    if (!(ret instanceof OutputStream)) {
      throw new TypeError('Resource error: Not a valid \"OutputStream\" resource.');
    }
    var handle0 = ret[symbolRscHandle];
    if (!handle0) {
      const rep = ret[symbolRscRep] || ++captureCnt3;
      captureTable3.set(rep, ret);
      handle0 = rscTableCreateOwn(handleTable3, rep);
    }
    
    _debugLog('[iface="wasi:cli/stderr@0.2.6", function="get-stderr"][Instruction::Return]', {
      funcName: 'get-stderr',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([handle0]);
    task.exit();
    return handle0;
  }
  _trampoline12.fnName = 'wasi:cli/stderr@0.2.6#getStderr';
  let exports1;
  let memory0;
  let realloc0;
  let realloc0Async;
  
  const _trampoline13 = function(arg0, arg1, arg2) {
    var ptr0 = arg0;
    var len0 = arg1;
    var result0 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr0, len0));
    _debugLog('[iface="host:interfaces/logging@2.1.0", function="info"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'info',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'result-catch-handler',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    try {
      const hostRet1 = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => info(result0),
      })
      ;
      ret = hostRet1 !== null && typeof hostRet1 === 'object' && (hostRet1.tag === 'ok' || hostRet1.tag === 'err')
      ? hostRet1
      : { tag: 'ok', val: hostRet1};
    } catch (e) {
      if (getOrCreateAsyncState(0).markTrapped(e)) { throw e; }
      ret = { tag: 'err', val: getErrorPayload(e) };
    }
    
    var variant3 = ret;
    switch (variant3.tag) {
      case 'ok': {
        const e = variant3.val;
        dataView(memory0).setInt8(arg2 + 0, 0, true);
        
        break;
      }
      case 'err': {
        const e = variant3.val;
        dataView(memory0).setInt8(arg2 + 0, 1, true);
        
        var encodeRes = _utf8AllocateAndEncode(e, realloc0, memory0);
        var ptr2= encodeRes.ptr;
        var len2 = encodeRes.len;
        
        dataView(memory0).setUint32(arg2 + 8, len2, true);
        dataView(memory0).setUint32(arg2 + 4, ptr2, true);
        
        break;
      }
      default: {
        _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant3, valueType: typeof variant3});
        throw new TypeError('invalid variant specified for result');
      }
    }
    _debugLog('[iface="host:interfaces/logging@2.1.0", function="info"][Instruction::Return]', {
      funcName: 'info',
      paramCount: 0,
      async: false,
      postReturn: false
    });
    task.resolve([ret]);
    task.exit();
  }
  _trampoline13.fnName = 'host:interfaces/logging@2.1.0#info';
  
  const _trampoline14 = function(arg0) {
    _debugLog('[iface="host:tenant/tenant-context@1.0.0", function="tenant-did"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'tenantDid',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => tenantDid(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    var val0 = ret;
    var len0 = Array.isArray(val0) ? val0.length : val0.byteLength;
    var ptr0 = realloc0(0, 0, 1, len0 * 1);
    
    let valData0;
    const valLenBytes0 = len0 * 1;
    if (Array.isArray(val0)) {
      // Regular array likely containing numbers, write values to memory
      let offset = 0;
      const dv0 = new DataView(memory0.buffer);
      for (const v of val0) {
        _requireValidNumericPrimitive.bind(null, 'u8')(v);
        dv0.setUint8(ptr0+ offset, v, true);
        offset += 1;
      }
    } else {
      // TypedArray / ArrayBuffer-like, direct copy
      valData0 = new Uint8Array(val0.buffer || val0, val0.byteOffset, valLenBytes0);
      const out0 = new Uint8Array(memory0.buffer, ptr0, valLenBytes0);
      out0.set(valData0);
    }
    
    dataView(memory0).setUint32(arg0 + 4, len0, true);
    dataView(memory0).setUint32(arg0 + 0, ptr0, true);
    _debugLog('[iface="host:tenant/tenant-context@1.0.0", function="tenant-did"][Instruction::Return]', {
      funcName: 'tenant-did',
      paramCount: 0,
      async: false,
      postReturn: false
    });
    task.resolve([ret]);
    task.exit();
  }
  _trampoline14.fnName = 'host:tenant/tenant-context@1.0.0#tenantDid';
  
  const _trampoline15 = function(arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
    var ptr0 = arg0;
    var len0 = arg1;
    var result0 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr0, len0));
    var ptr1 = arg2;
    var len1 = arg3;
    if (ptr1 % 1 !== 0) throw new TypeError(`list pointer [${ptr1}] is not aligned to 1`);
    var result1 = new Uint8Array(memory0.buffer.slice(ptr1, ptr1 + len1 * 1));
    var ptr2 = arg4;
    var len2 = arg5;
    if (ptr2 % 1 !== 0) throw new TypeError(`list pointer [${ptr2}] is not aligned to 1`);
    var result2 = new Uint8Array(memory0.buffer.slice(ptr2, ptr2 + len2 * 1));
    _debugLog('[iface="host:interfaces/kv-store@2.1.0", function="put"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'put',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'result-catch-handler',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    try {
      const hostRet3 = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => put(result0, result1, result2),
      })
      ;
      ret = hostRet3 !== null && typeof hostRet3 === 'object' && (hostRet3.tag === 'ok' || hostRet3.tag === 'err')
      ? hostRet3
      : { tag: 'ok', val: hostRet3};
    } catch (e) {
      if (getOrCreateAsyncState(0).markTrapped(e)) { throw e; }
      ret = { tag: 'err', val: getErrorPayload(e) };
    }
    
    var variant5 = ret;
    switch (variant5.tag) {
      case 'ok': {
        const e = variant5.val;
        dataView(memory0).setInt8(arg6 + 0, 0, true);
        
        break;
      }
      case 'err': {
        const e = variant5.val;
        dataView(memory0).setInt8(arg6 + 0, 1, true);
        
        var encodeRes = _utf8AllocateAndEncode(e, realloc0, memory0);
        var ptr4= encodeRes.ptr;
        var len4 = encodeRes.len;
        
        dataView(memory0).setUint32(arg6 + 8, len4, true);
        dataView(memory0).setUint32(arg6 + 4, ptr4, true);
        
        break;
      }
      default: {
        _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant5, valueType: typeof variant5});
        throw new TypeError('invalid variant specified for result');
      }
    }
    _debugLog('[iface="host:interfaces/kv-store@2.1.0", function="put"][Instruction::Return]', {
      funcName: 'put',
      paramCount: 0,
      async: false,
      postReturn: false
    });
    task.resolve([ret]);
    task.exit();
  }
  _trampoline15.fnName = 'host:interfaces/kv-store@2.1.0#put';
  
  const _trampoline16 = function(arg0, arg1, arg2, arg3, arg4) {
    var ptr0 = arg0;
    var len0 = arg1;
    var result0 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr0, len0));
    var ptr1 = arg2;
    var len1 = arg3;
    if (ptr1 % 1 !== 0) throw new TypeError(`list pointer [${ptr1}] is not aligned to 1`);
    var result1 = new Uint8Array(memory0.buffer.slice(ptr1, ptr1 + len1 * 1));
    _debugLog('[iface="host:interfaces/kv-store@2.1.0", function="get"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'get',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'result-catch-handler',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    try {
      const hostRet2 = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => get(result0, result1),
      })
      ;
      ret = hostRet2 !== null && typeof hostRet2 === 'object' && (hostRet2.tag === 'ok' || hostRet2.tag === 'err')
      ? hostRet2
      : { tag: 'ok', val: hostRet2};
    } catch (e) {
      if (getOrCreateAsyncState(0).markTrapped(e)) { throw e; }
      ret = { tag: 'err', val: getErrorPayload(e) };
    }
    
    var variant6 = ret;
    switch (variant6.tag) {
      case 'ok': {
        const e = variant6.val;
        dataView(memory0).setInt8(arg4 + 0, 0, true);
        var variant4 = e;
        if (variant4 === null || variant4=== undefined) {
          dataView(memory0).setInt8(arg4 + 4, 0, true);
        } else {
          const e = variant4;
          dataView(memory0).setInt8(arg4 + 4, 1, true);
          var val3 = e;
          var len3 = Array.isArray(val3) ? val3.length : val3.byteLength;
          var ptr3 = realloc0(0, 0, 1, len3 * 1);
          
          let valData3;
          const valLenBytes3 = len3 * 1;
          if (Array.isArray(val3)) {
            // Regular array likely containing numbers, write values to memory
            let offset = 0;
            const dv3 = new DataView(memory0.buffer);
            for (const v of val3) {
              _requireValidNumericPrimitive.bind(null, 'u8')(v);
              dv3.setUint8(ptr3+ offset, v, true);
              offset += 1;
            }
          } else {
            // TypedArray / ArrayBuffer-like, direct copy
            valData3 = new Uint8Array(val3.buffer || val3, val3.byteOffset, valLenBytes3);
            const out3 = new Uint8Array(memory0.buffer, ptr3, valLenBytes3);
            out3.set(valData3);
          }
          
          dataView(memory0).setUint32(arg4 + 12, len3, true);
          dataView(memory0).setUint32(arg4 + 8, ptr3, true);
        }
        
        break;
      }
      case 'err': {
        const e = variant6.val;
        dataView(memory0).setInt8(arg4 + 0, 1, true);
        
        var encodeRes = _utf8AllocateAndEncode(e, realloc0, memory0);
        var ptr5= encodeRes.ptr;
        var len5 = encodeRes.len;
        
        dataView(memory0).setUint32(arg4 + 8, len5, true);
        dataView(memory0).setUint32(arg4 + 4, ptr5, true);
        
        break;
      }
      default: {
        _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant6, valueType: typeof variant6});
        throw new TypeError('invalid variant specified for result');
      }
    }
    _debugLog('[iface="host:interfaces/kv-store@2.1.0", function="get"][Instruction::Return]', {
      funcName: 'get',
      paramCount: 0,
      async: false,
      postReturn: false
    });
    task.resolve([ret]);
    task.exit();
  }
  _trampoline16.fnName = 'host:interfaces/kv-store@2.1.0#get';
  
  const _trampoline17 = function(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
    let enum0;
    switch (arg0) {
      case 0: {
        enum0 = 'get';
        break;
      }
      case 1: {
        enum0 = 'post';
        break;
      }
      case 2: {
        enum0 = 'put';
        break;
      }
      case 3: {
        enum0 = 'patch';
        break;
      }
      case 4: {
        enum0 = 'delete';
        break;
      }
      default: {
        throw new TypeError('invalid discriminant specified for Verb');
      }
    }
    var ptr1 = arg1;
    var len1 = arg2;
    var result1 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr1, len1));
    let variant5;
    switch (arg3) {
      case 0: {
        variant5 = undefined;
        break;
      }
      case 1: {
        var len4 = arg5;
        var base4 = arg4;
        if (base4 % 4 !== 0) throw new TypeError(`list pointer [${base4}] is not aligned to 4`);
        var result4 = [];
        for (let i = 0; i < len4; i++) {
          const base = base4 + i * 16;
          var ptr2 = dataView(memory0).getUint32(base + 0, true);
          var len2 = dataView(memory0).getUint32(base + 4, true);
          var result2 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr2, len2));
          var ptr3 = dataView(memory0).getUint32(base + 8, true);
          var len3 = dataView(memory0).getUint32(base + 12, true);
          var result3 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr3, len3));
          result4.push([result2, result3]);
        }
        variant5 = result4;
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    let variant7;
    switch (arg6) {
      case 0: {
        variant7 = undefined;
        break;
      }
      case 1: {
        var ptr6 = arg7;
        var len6 = arg8;
        if (ptr6 % 1 !== 0) throw new TypeError(`list pointer [${ptr6}] is not aligned to 1`);
        var result6 = new Uint8Array(memory0.buffer.slice(ptr6, ptr6 + len6 * 1));
        variant7 = result6;
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    _debugLog('[iface="host:interfaces/http-with-placeholders@2.1.0", function="call"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'call',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'result-catch-handler',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    try {
      const hostRet8 = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => call({
          method: enum0,
          url: result1,
          headers: variant5,
          payload: variant7,
        }),
      })
      ;
      ret = hostRet8 !== null && typeof hostRet8 === 'object' && (hostRet8.tag === 'ok' || hostRet8.tag === 'err')
      ? hostRet8
      : { tag: 'ok', val: hostRet8};
    } catch (e) {
      if (getOrCreateAsyncState(0).markTrapped(e)) { throw e; }
      ret = { tag: 'err', val: getErrorPayload(e) };
    }
    
    var variant16 = ret;
    switch (variant16.tag) {
      case 'ok': {
        const e = variant16.val;
        dataView(memory0).setInt8(arg9 + 0, 0, true);
        var {code: v9_0, payload: v9_1 } = e;
        dataView(memory0).setInt16(arg9 + 4, toUint16(v9_0), true);
        var val10 = v9_1;
        var len10 = Array.isArray(val10) ? val10.length : val10.byteLength;
        var ptr10 = realloc0(0, 0, 1, len10 * 1);
        
        let valData10;
        const valLenBytes10 = len10 * 1;
        if (Array.isArray(val10)) {
          // Regular array likely containing numbers, write values to memory
          let offset = 0;
          const dv10 = new DataView(memory0.buffer);
          for (const v of val10) {
            _requireValidNumericPrimitive.bind(null, 'u8')(v);
            dv10.setUint8(ptr10+ offset, v, true);
            offset += 1;
          }
        } else {
          // TypedArray / ArrayBuffer-like, direct copy
          valData10 = new Uint8Array(val10.buffer || val10, val10.byteOffset, valLenBytes10);
          const out10 = new Uint8Array(memory0.buffer, ptr10, valLenBytes10);
          out10.set(valData10);
        }
        
        dataView(memory0).setUint32(arg9 + 12, len10, true);
        dataView(memory0).setUint32(arg9 + 8, ptr10, true);
        
        break;
      }
      case 'err': {
        const e = variant16.val;
        dataView(memory0).setInt8(arg9 + 0, 1, true);
        var variant15 = e;
        switch (variant15.tag) {
          case 'egress-denied': {
            const e = variant15.val;
            dataView(memory0).setInt8(arg9 + 4, 0, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc0, memory0);
            var ptr11= encodeRes.ptr;
            var len11 = encodeRes.len;
            
            dataView(memory0).setUint32(arg9 + 12, len11, true);
            dataView(memory0).setUint32(arg9 + 8, ptr11, true);
            break;
          }
          case 'placeholder-denied': {
            const e = variant15.val;
            dataView(memory0).setInt8(arg9 + 4, 1, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc0, memory0);
            var ptr12= encodeRes.ptr;
            var len12 = encodeRes.len;
            
            dataView(memory0).setUint32(arg9 + 12, len12, true);
            dataView(memory0).setUint32(arg9 + 8, ptr12, true);
            break;
          }
          case 'placeholder-unknown': {
            const e = variant15.val;
            dataView(memory0).setInt8(arg9 + 4, 2, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc0, memory0);
            var ptr13= encodeRes.ptr;
            var len13 = encodeRes.len;
            
            dataView(memory0).setUint32(arg9 + 12, len13, true);
            dataView(memory0).setUint32(arg9 + 8, ptr13, true);
            break;
          }
          case 'placeholder-no-user-context': {
            dataView(memory0).setInt8(arg9 + 4, 3, true);
            break;
          }
          case 'upstream-error': {
            const e = variant15.val;
            dataView(memory0).setInt8(arg9 + 4, 4, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc0, memory0);
            var ptr14= encodeRes.ptr;
            var len14 = encodeRes.len;
            
            dataView(memory0).setUint32(arg9 + 12, len14, true);
            dataView(memory0).setUint32(arg9 + 8, ptr14, true);
            break;
          }
          default: {
            throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant15.tag)}\` (received \`${variant15}\`) specified for \`HttpError\``);
          }
        }
        
        break;
      }
      default: {
        _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant16, valueType: typeof variant16});
        throw new TypeError('invalid variant specified for result');
      }
    }
    _debugLog('[iface="host:interfaces/http-with-placeholders@2.1.0", function="call"][Instruction::Return]', {
      funcName: 'call',
      paramCount: 0,
      async: false,
      postReturn: false
    });
    task.resolve([ret]);
    task.exit();
  }
  _trampoline17.fnName = 'host:interfaces/http-with-placeholders@2.1.0#call';
  
  const _trampoline18 = function(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
    let enum0;
    switch (arg0) {
      case 0: {
        enum0 = 'get';
        break;
      }
      case 1: {
        enum0 = 'post';
        break;
      }
      case 2: {
        enum0 = 'put';
        break;
      }
      case 3: {
        enum0 = 'patch';
        break;
      }
      case 4: {
        enum0 = 'delete';
        break;
      }
      default: {
        throw new TypeError('invalid discriminant specified for Verb');
      }
    }
    var ptr1 = arg1;
    var len1 = arg2;
    var result1 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr1, len1));
    let variant5;
    switch (arg3) {
      case 0: {
        variant5 = undefined;
        break;
      }
      case 1: {
        var len4 = arg5;
        var base4 = arg4;
        if (base4 % 4 !== 0) throw new TypeError(`list pointer [${base4}] is not aligned to 4`);
        var result4 = [];
        for (let i = 0; i < len4; i++) {
          const base = base4 + i * 16;
          var ptr2 = dataView(memory0).getUint32(base + 0, true);
          var len2 = dataView(memory0).getUint32(base + 4, true);
          var result2 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr2, len2));
          var ptr3 = dataView(memory0).getUint32(base + 8, true);
          var len3 = dataView(memory0).getUint32(base + 12, true);
          var result3 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr3, len3));
          result4.push([result2, result3]);
        }
        variant5 = result4;
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    let variant7;
    switch (arg6) {
      case 0: {
        variant7 = undefined;
        break;
      }
      case 1: {
        var ptr6 = arg7;
        var len6 = arg8;
        if (ptr6 % 1 !== 0) throw new TypeError(`list pointer [${ptr6}] is not aligned to 1`);
        var result6 = new Uint8Array(memory0.buffer.slice(ptr6, ptr6 + len6 * 1));
        variant7 = result6;
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    _debugLog('[iface="host:interfaces/http@2.1.0", function="call"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'call$1',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'result-catch-handler',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    try {
      const hostRet8 = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => call$1({
          method: enum0,
          url: result1,
          headers: variant5,
          payload: variant7,
        }),
      })
      ;
      ret = hostRet8 !== null && typeof hostRet8 === 'object' && (hostRet8.tag === 'ok' || hostRet8.tag === 'err')
      ? hostRet8
      : { tag: 'ok', val: hostRet8};
    } catch (e) {
      if (getOrCreateAsyncState(0).markTrapped(e)) { throw e; }
      ret = { tag: 'err', val: getErrorPayload(e) };
    }
    
    var variant12 = ret;
    switch (variant12.tag) {
      case 'ok': {
        const e = variant12.val;
        dataView(memory0).setInt8(arg9 + 0, 0, true);
        var {code: v9_0, payload: v9_1 } = e;
        dataView(memory0).setInt16(arg9 + 4, toUint16(v9_0), true);
        var val10 = v9_1;
        var len10 = Array.isArray(val10) ? val10.length : val10.byteLength;
        var ptr10 = realloc0(0, 0, 1, len10 * 1);
        
        let valData10;
        const valLenBytes10 = len10 * 1;
        if (Array.isArray(val10)) {
          // Regular array likely containing numbers, write values to memory
          let offset = 0;
          const dv10 = new DataView(memory0.buffer);
          for (const v of val10) {
            _requireValidNumericPrimitive.bind(null, 'u8')(v);
            dv10.setUint8(ptr10+ offset, v, true);
            offset += 1;
          }
        } else {
          // TypedArray / ArrayBuffer-like, direct copy
          valData10 = new Uint8Array(val10.buffer || val10, val10.byteOffset, valLenBytes10);
          const out10 = new Uint8Array(memory0.buffer, ptr10, valLenBytes10);
          out10.set(valData10);
        }
        
        dataView(memory0).setUint32(arg9 + 12, len10, true);
        dataView(memory0).setUint32(arg9 + 8, ptr10, true);
        
        break;
      }
      case 'err': {
        const e = variant12.val;
        dataView(memory0).setInt8(arg9 + 0, 1, true);
        
        var encodeRes = _utf8AllocateAndEncode(e, realloc0, memory0);
        var ptr11= encodeRes.ptr;
        var len11 = encodeRes.len;
        
        dataView(memory0).setUint32(arg9 + 8, len11, true);
        dataView(memory0).setUint32(arg9 + 4, ptr11, true);
        
        break;
      }
      default: {
        _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant12, valueType: typeof variant12});
        throw new TypeError('invalid variant specified for result');
      }
    }
    _debugLog('[iface="host:interfaces/http@2.1.0", function="call"][Instruction::Return]', {
      funcName: 'call',
      paramCount: 0,
      async: false,
      postReturn: false
    });
    task.resolve([ret]);
    task.exit();
  }
  _trampoline18.fnName = 'host:interfaces/http@2.1.0#call$1';
  
  const handleTable1 = [T_FLAG, 0];
  handleTable1._createdReps = new Set();
  
  
  const captureTable1= new Map();
  let captureCnt1= 0;
  
  HANDLE_TABLES[1] = handleTable1;
  
  const _trampoline19 = function(arg0, arg1) {
    var handle1 = arg0;
    
    var rep2 = handleTable3[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable3.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(OutputStream.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]output-stream.check-write"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'checkWrite',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'result-catch-handler',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    try {
      const hostRet3 = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.checkWrite(),
      })
      ;
      ret = hostRet3 !== null && typeof hostRet3 === 'object' && (hostRet3.tag === 'ok' || hostRet3.tag === 'err')
      ? hostRet3
      : { tag: 'ok', val: hostRet3};
    } catch (e) {
      if (getOrCreateAsyncState(0).markTrapped(e)) { throw e; }
      ret = { tag: 'err', val: getErrorPayload(e) };
    }
    
    for (const entry of curResourceBorrows) {
      const rsc = entry.rsc ?? entry;
      if (entry.drop) {
        if (rsc[symbolRscHandle]) {
          entry.drop(rsc[symbolRscHandle]);
        }
      }
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    var variant6 = ret;
    switch (variant6.tag) {
      case 'ok': {
        const e = variant6.val;
        dataView(memory0).setInt8(arg1 + 0, 0, true);
        dataView(memory0).setBigInt64(arg1 + 8, toUint64(e), true);
        
        break;
      }
      case 'err': {
        const e = variant6.val;
        dataView(memory0).setInt8(arg1 + 0, 1, true);
        var variant5 = e;
        switch (variant5.tag) {
          case 'last-operation-failed': {
            const e = variant5.val;
            dataView(memory0).setInt8(arg1 + 8, 0, true);
            
            if (!(e instanceof Error$1)) {
              throw new TypeError('Resource error: Not a valid \"Error\" resource.');
            }
            var handle4 = e[symbolRscHandle];
            if (!handle4) {
              const rep = e[symbolRscRep] || ++captureCnt1;
              captureTable1.set(rep, e);
              handle4 = rscTableCreateOwn(handleTable1, rep);
            }
            
            dataView(memory0).setInt32(arg1 + 12, handle4, true);
            break;
          }
          case 'closed': {
            dataView(memory0).setInt8(arg1 + 8, 1, true);
            break;
          }
          default: {
            throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant5.tag)}\` (received \`${variant5}\`) specified for \`StreamError\``);
          }
        }
        
        break;
      }
      default: {
        _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant6, valueType: typeof variant6});
        throw new TypeError('invalid variant specified for result');
      }
    }
    _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]output-stream.check-write"][Instruction::Return]', {
      funcName: '[method]output-stream.check-write',
      paramCount: 0,
      async: false,
      postReturn: false
    });
    task.resolve([ret]);
    task.exit();
  }
  _trampoline19.fnName = 'wasi:io/streams@0.2.6#checkWrite';
  
  const _trampoline20 = function(arg0, arg1, arg2, arg3) {
    var handle1 = arg0;
    
    var rep2 = handleTable3[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable3.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(OutputStream.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    var ptr3 = arg1;
    var len3 = arg2;
    if (ptr3 % 1 !== 0) throw new TypeError(`list pointer [${ptr3}] is not aligned to 1`);
    var result3 = new Uint8Array(memory0.buffer.slice(ptr3, ptr3 + len3 * 1));
    _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]output-stream.write"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'write',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'result-catch-handler',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    try {
      const hostRet4 = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.write(result3),
      })
      ;
      ret = hostRet4 !== null && typeof hostRet4 === 'object' && (hostRet4.tag === 'ok' || hostRet4.tag === 'err')
      ? hostRet4
      : { tag: 'ok', val: hostRet4};
    } catch (e) {
      if (getOrCreateAsyncState(0).markTrapped(e)) { throw e; }
      ret = { tag: 'err', val: getErrorPayload(e) };
    }
    
    for (const entry of curResourceBorrows) {
      const rsc = entry.rsc ?? entry;
      if (entry.drop) {
        if (rsc[symbolRscHandle]) {
          entry.drop(rsc[symbolRscHandle]);
        }
      }
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    var variant7 = ret;
    switch (variant7.tag) {
      case 'ok': {
        const e = variant7.val;
        dataView(memory0).setInt8(arg3 + 0, 0, true);
        
        break;
      }
      case 'err': {
        const e = variant7.val;
        dataView(memory0).setInt8(arg3 + 0, 1, true);
        var variant6 = e;
        switch (variant6.tag) {
          case 'last-operation-failed': {
            const e = variant6.val;
            dataView(memory0).setInt8(arg3 + 4, 0, true);
            
            if (!(e instanceof Error$1)) {
              throw new TypeError('Resource error: Not a valid \"Error\" resource.');
            }
            var handle5 = e[symbolRscHandle];
            if (!handle5) {
              const rep = e[symbolRscRep] || ++captureCnt1;
              captureTable1.set(rep, e);
              handle5 = rscTableCreateOwn(handleTable1, rep);
            }
            
            dataView(memory0).setInt32(arg3 + 8, handle5, true);
            break;
          }
          case 'closed': {
            dataView(memory0).setInt8(arg3 + 4, 1, true);
            break;
          }
          default: {
            throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant6.tag)}\` (received \`${variant6}\`) specified for \`StreamError\``);
          }
        }
        
        break;
      }
      default: {
        _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant7, valueType: typeof variant7});
        throw new TypeError('invalid variant specified for result');
      }
    }
    _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]output-stream.write"][Instruction::Return]', {
      funcName: '[method]output-stream.write',
      paramCount: 0,
      async: false,
      postReturn: false
    });
    task.resolve([ret]);
    task.exit();
  }
  _trampoline20.fnName = 'wasi:io/streams@0.2.6#write';
  
  const _trampoline21 = function(arg0, arg1) {
    var handle1 = arg0;
    
    var rep2 = handleTable3[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable3.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(OutputStream.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]output-stream.blocking-flush"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'blockingFlush',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'result-catch-handler',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    try {
      const hostRet3 = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.blockingFlush(),
      })
      ;
      ret = hostRet3 !== null && typeof hostRet3 === 'object' && (hostRet3.tag === 'ok' || hostRet3.tag === 'err')
      ? hostRet3
      : { tag: 'ok', val: hostRet3};
    } catch (e) {
      if (getOrCreateAsyncState(0).markTrapped(e)) { throw e; }
      ret = { tag: 'err', val: getErrorPayload(e) };
    }
    
    for (const entry of curResourceBorrows) {
      const rsc = entry.rsc ?? entry;
      if (entry.drop) {
        if (rsc[symbolRscHandle]) {
          entry.drop(rsc[symbolRscHandle]);
        }
      }
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    var variant6 = ret;
    switch (variant6.tag) {
      case 'ok': {
        const e = variant6.val;
        dataView(memory0).setInt8(arg1 + 0, 0, true);
        
        break;
      }
      case 'err': {
        const e = variant6.val;
        dataView(memory0).setInt8(arg1 + 0, 1, true);
        var variant5 = e;
        switch (variant5.tag) {
          case 'last-operation-failed': {
            const e = variant5.val;
            dataView(memory0).setInt8(arg1 + 4, 0, true);
            
            if (!(e instanceof Error$1)) {
              throw new TypeError('Resource error: Not a valid \"Error\" resource.');
            }
            var handle4 = e[symbolRscHandle];
            if (!handle4) {
              const rep = e[symbolRscRep] || ++captureCnt1;
              captureTable1.set(rep, e);
              handle4 = rscTableCreateOwn(handleTable1, rep);
            }
            
            dataView(memory0).setInt32(arg1 + 8, handle4, true);
            break;
          }
          case 'closed': {
            dataView(memory0).setInt8(arg1 + 4, 1, true);
            break;
          }
          default: {
            throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant5.tag)}\` (received \`${variant5}\`) specified for \`StreamError\``);
          }
        }
        
        break;
      }
      default: {
        _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant6, valueType: typeof variant6});
        throw new TypeError('invalid variant specified for result');
      }
    }
    _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]output-stream.blocking-flush"][Instruction::Return]', {
      funcName: '[method]output-stream.blocking-flush',
      paramCount: 0,
      async: false,
      postReturn: false
    });
    task.resolve([ret]);
    task.exit();
  }
  _trampoline21.fnName = 'wasi:io/streams@0.2.6#blockingFlush';
  
  const _trampoline22 = function(arg0) {
    _debugLog('[iface="wasi:cli/environment@0.2.6", function="get-environment"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'getEnvironment',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => getEnvironment(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    var vec3 = ret;
    var len3 = vec3.length;
    var result3 = realloc0(0, 0, 4, len3 * 16);
    for (let i = 0; i < vec3.length; i++) {
      const e = vec3[i];
      const base = result3 + i * 16;var [tuple0_0, tuple0_1] = e;
      
      var encodeRes = _utf8AllocateAndEncode(tuple0_0, realloc0, memory0);
      var ptr1= encodeRes.ptr;
      var len1 = encodeRes.len;
      
      dataView(memory0).setUint32(base + 4, len1, true);
      dataView(memory0).setUint32(base + 0, ptr1, true);
      
      var encodeRes = _utf8AllocateAndEncode(tuple0_1, realloc0, memory0);
      var ptr2= encodeRes.ptr;
      var len2 = encodeRes.len;
      
      dataView(memory0).setUint32(base + 12, len2, true);
      dataView(memory0).setUint32(base + 8, ptr2, true);
    }
    dataView(memory0).setUint32(arg0 + 4, len3, true);
    dataView(memory0).setUint32(arg0 + 0, result3, true);
    _debugLog('[iface="wasi:cli/environment@0.2.6", function="get-environment"][Instruction::Return]', {
      funcName: 'get-environment',
      paramCount: 0,
      async: false,
      postReturn: false
    });
    task.resolve([ret]);
    task.exit();
  }
  _trampoline22.fnName = 'wasi:cli/environment@0.2.6#getEnvironment';
  
  const handleTable4 = [T_FLAG, 0];
  handleTable4._createdReps = new Set();
  
  
  const captureTable4= new Map();
  let captureCnt4= 0;
  
  HANDLE_TABLES[4] = handleTable4;
  
  const _trampoline23 = function(arg0) {
    _debugLog('[iface="wasi:cli/terminal-stdin@0.2.6", function="get-terminal-stdin"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'getTerminalStdin',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => getTerminalStdin(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    var variant1 = ret;
    if (variant1 === null || variant1=== undefined) {
      dataView(memory0).setInt8(arg0 + 0, 0, true);
    } else {
      const e = variant1;
      dataView(memory0).setInt8(arg0 + 0, 1, true);
      
      if (!(e instanceof TerminalInput)) {
        throw new TypeError('Resource error: Not a valid \"TerminalInput\" resource.');
      }
      var handle0 = e[symbolRscHandle];
      if (!handle0) {
        const rep = e[symbolRscRep] || ++captureCnt4;
        captureTable4.set(rep, e);
        handle0 = rscTableCreateOwn(handleTable4, rep);
      }
      
      dataView(memory0).setInt32(arg0 + 4, handle0, true);
    }
    _debugLog('[iface="wasi:cli/terminal-stdin@0.2.6", function="get-terminal-stdin"][Instruction::Return]', {
      funcName: 'get-terminal-stdin',
      paramCount: 0,
      async: false,
      postReturn: false
    });
    task.resolve([ret]);
    task.exit();
  }
  _trampoline23.fnName = 'wasi:cli/terminal-stdin@0.2.6#getTerminalStdin';
  
  const handleTable5 = [T_FLAG, 0];
  handleTable5._createdReps = new Set();
  
  
  const captureTable5= new Map();
  let captureCnt5= 0;
  
  HANDLE_TABLES[5] = handleTable5;
  
  const _trampoline24 = function(arg0) {
    _debugLog('[iface="wasi:cli/terminal-stdout@0.2.6", function="get-terminal-stdout"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'getTerminalStdout',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => getTerminalStdout(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    var variant1 = ret;
    if (variant1 === null || variant1=== undefined) {
      dataView(memory0).setInt8(arg0 + 0, 0, true);
    } else {
      const e = variant1;
      dataView(memory0).setInt8(arg0 + 0, 1, true);
      
      if (!(e instanceof TerminalOutput)) {
        throw new TypeError('Resource error: Not a valid \"TerminalOutput\" resource.');
      }
      var handle0 = e[symbolRscHandle];
      if (!handle0) {
        const rep = e[symbolRscRep] || ++captureCnt5;
        captureTable5.set(rep, e);
        handle0 = rscTableCreateOwn(handleTable5, rep);
      }
      
      dataView(memory0).setInt32(arg0 + 4, handle0, true);
    }
    _debugLog('[iface="wasi:cli/terminal-stdout@0.2.6", function="get-terminal-stdout"][Instruction::Return]', {
      funcName: 'get-terminal-stdout',
      paramCount: 0,
      async: false,
      postReturn: false
    });
    task.resolve([ret]);
    task.exit();
  }
  _trampoline24.fnName = 'wasi:cli/terminal-stdout@0.2.6#getTerminalStdout';
  
  const _trampoline25 = function(arg0) {
    _debugLog('[iface="wasi:cli/terminal-stderr@0.2.6", function="get-terminal-stderr"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'getTerminalStderr',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => getTerminalStderr(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    var variant1 = ret;
    if (variant1 === null || variant1=== undefined) {
      dataView(memory0).setInt8(arg0 + 0, 0, true);
    } else {
      const e = variant1;
      dataView(memory0).setInt8(arg0 + 0, 1, true);
      
      if (!(e instanceof TerminalOutput)) {
        throw new TypeError('Resource error: Not a valid \"TerminalOutput\" resource.');
      }
      var handle0 = e[symbolRscHandle];
      if (!handle0) {
        const rep = e[symbolRscRep] || ++captureCnt5;
        captureTable5.set(rep, e);
        handle0 = rscTableCreateOwn(handleTable5, rep);
      }
      
      dataView(memory0).setInt32(arg0 + 4, handle0, true);
    }
    _debugLog('[iface="wasi:cli/terminal-stderr@0.2.6", function="get-terminal-stderr"][Instruction::Return]', {
      funcName: 'get-terminal-stderr',
      paramCount: 0,
      async: false,
      postReturn: false
    });
    task.resolve([ret]);
    task.exit();
  }
  _trampoline25.fnName = 'wasi:cli/terminal-stderr@0.2.6#getTerminalStderr';
  let exports2;
  let postReturn0;
  let postReturn0Async;
  let contracts010Evaluate;
  
  function evaluate(arg0) {
    
    const hostProvided = false;
    getOrCreateAsyncState(0).throwIfTrapped();
    
    const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
      componentIdx: 0,
      isAsync: false,
      isManualAsync: false,
      preserveFutureResult: false,
      entryFnName: 'contracts010Evaluate',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'throw-result-err',
      callingWasmExport: true,
    });
    
    const started = task.enterSync();
    
    if (0!== null) {
      task.setReturnMemoryIdx(0);
      task.setReturnMemory(() => memory0());
    }
    
    
    return _withGlobalCurrentTaskMeta({
      taskID: task.id(),
      componentIdx: task.componentIdx(),
      fn: () => {
        try {
          
          var {input: v0_0, userProfile: v0_1, context: v0_2 } = arg0;
          var variant2 = v0_0;
          let variant2_0;
          let variant2_1;
          let variant2_2;
          if (variant2 === null || variant2=== undefined) {
            variant2_0 = 0;
            variant2_1 = 0;
            variant2_2 = 0;
          } else {
            const e = variant2;
            var val1 = e;
            var len1 = Array.isArray(val1) ? val1.length : val1.byteLength;
            var ptr1 = realloc0(0, 0, 1, len1 * 1);
            
            let valData1;
            const valLenBytes1 = len1 * 1;
            if (Array.isArray(val1)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv1 = new DataView(memory0.buffer);
              for (const v of val1) {
                _requireValidNumericPrimitive.bind(null, 'u8')(v);
                dv1.setUint8(ptr1+ offset, v, true);
                offset += 1;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData1 = new Uint8Array(val1.buffer || val1, val1.byteOffset, valLenBytes1);
              const out1 = new Uint8Array(memory0.buffer, ptr1, valLenBytes1);
              out1.set(valData1);
            }
            
            variant2_0 = 1;
            variant2_1 = ptr1;
            variant2_2 = len1;
          }
          var variant4 = v0_1;
          let variant4_0;
          let variant4_1;
          let variant4_2;
          if (variant4 === null || variant4=== undefined) {
            variant4_0 = 0;
            variant4_1 = 0;
            variant4_2 = 0;
          } else {
            const e = variant4;
            var val3 = e;
            var len3 = Array.isArray(val3) ? val3.length : val3.byteLength;
            var ptr3 = realloc0(0, 0, 1, len3 * 1);
            
            let valData3;
            const valLenBytes3 = len3 * 1;
            if (Array.isArray(val3)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv3 = new DataView(memory0.buffer);
              for (const v of val3) {
                _requireValidNumericPrimitive.bind(null, 'u8')(v);
                dv3.setUint8(ptr3+ offset, v, true);
                offset += 1;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData3 = new Uint8Array(val3.buffer || val3, val3.byteOffset, valLenBytes3);
              const out3 = new Uint8Array(memory0.buffer, ptr3, valLenBytes3);
              out3.set(valData3);
            }
            
            variant4_0 = 1;
            variant4_1 = ptr3;
            variant4_2 = len3;
          }
          var variant6 = v0_2;
          let variant6_0;
          let variant6_1;
          let variant6_2;
          if (variant6 === null || variant6=== undefined) {
            variant6_0 = 0;
            variant6_1 = 0;
            variant6_2 = 0;
          } else {
            const e = variant6;
            var val5 = e;
            var len5 = Array.isArray(val5) ? val5.length : val5.byteLength;
            var ptr5 = realloc0(0, 0, 1, len5 * 1);
            
            let valData5;
            const valLenBytes5 = len5 * 1;
            if (Array.isArray(val5)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv5 = new DataView(memory0.buffer);
              for (const v of val5) {
                _requireValidNumericPrimitive.bind(null, 'u8')(v);
                dv5.setUint8(ptr5+ offset, v, true);
                offset += 1;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData5 = new Uint8Array(val5.buffer || val5, val5.byteOffset, valLenBytes5);
              const out5 = new Uint8Array(memory0.buffer, ptr5, valLenBytes5);
              out5.set(valData5);
            }
            
            variant6_0 = 1;
            variant6_1 = ptr5;
            variant6_2 = len5;
          }
          _debugLog('[iface="z:gate-contract/contracts@0.1.0", function="evaluate"][Instruction::CallWasm] enter', {
            funcName: 'evaluate',
            paramCount: 9,
            async: false,
            postReturn: true,
          });
          
          let ret;
          
          try {
            ret =  contracts010Evaluate(variant2_0, variant2_1, variant2_2, variant4_0, variant4_1, variant4_2, variant6_0, variant6_1, variant6_2);
          } catch (err) {
            
            _debugLog('[Instruction::CallWasm] error during sync call', {
              taskID: task.id(),
              err,
            });
            getOrCreateAsyncState(0).markTrapped(err);
            task.setErrored(err);
            task.reject(err);
            task.exit();
            throw err;
            
          }
          
          let variant9;
          switch (dataView(memory0).getUint8(ret + 0, true)) {
            case 0: {
              var ptr7 = dataView(memory0).getUint32(ret + 4, true);
              var len7 = dataView(memory0).getUint32(ret + 8, true);
              if (ptr7 % 1 !== 0) throw new TypeError(`list pointer [${ptr7}] is not aligned to 1`);
              var result7 = new Uint8Array(memory0.buffer.slice(ptr7, ptr7 + len7 * 1));
              variant9= {
                tag: 'ok',
                val: result7
              };
              break;
            }
            case 1: {
              var ptr8 = dataView(memory0).getUint32(ret + 4, true);
              var len8 = dataView(memory0).getUint32(ret + 8, true);
              var result8 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr8, len8));
              variant9= {
                tag: 'err',
                val: result8
              };
              break;
            }
            default: {
              throw new TypeError('invalid variant discriminant for expected');
            }
          }
          _debugLog('[iface="z:gate-contract/contracts@0.1.0", function="evaluate"][Instruction::Return]', {
            funcName: 'evaluate',
            paramCount: 1,
            async: false,
            postReturn: true
          });
          const retCopy = variant9;
          task.resolve([retCopy.val]);
          
          let cstate = getOrCreateAsyncState(0);
          cstate.mayLeave = false;
          postReturn0(ret);
          cstate.mayLeave = true;
          task.exit();
          
          
          
          if (typeof retCopy === 'object' && retCopy.tag === 'err') {
            throw new ComponentError(retCopy.val);
          }
          return retCopy.val;
          
          
        } catch (err) {
          if (!task.isResolvedState()) {
            task.setErrored(err);
            task.reject(err);
          }
          if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
          throw err;
        }
      },
    });
    
  }
  let contracts010Spend;
  
  function spend(arg0) {
    
    const hostProvided = false;
    getOrCreateAsyncState(0).throwIfTrapped();
    
    const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
      componentIdx: 0,
      isAsync: false,
      isManualAsync: false,
      preserveFutureResult: false,
      entryFnName: 'contracts010Spend',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'throw-result-err',
      callingWasmExport: true,
    });
    
    const started = task.enterSync();
    
    if (0!== null) {
      task.setReturnMemoryIdx(0);
      task.setReturnMemory(() => memory0());
    }
    
    
    return _withGlobalCurrentTaskMeta({
      taskID: task.id(),
      componentIdx: task.componentIdx(),
      fn: () => {
        try {
          
          var {input: v0_0, userProfile: v0_1, context: v0_2 } = arg0;
          var variant2 = v0_0;
          let variant2_0;
          let variant2_1;
          let variant2_2;
          if (variant2 === null || variant2=== undefined) {
            variant2_0 = 0;
            variant2_1 = 0;
            variant2_2 = 0;
          } else {
            const e = variant2;
            var val1 = e;
            var len1 = Array.isArray(val1) ? val1.length : val1.byteLength;
            var ptr1 = realloc0(0, 0, 1, len1 * 1);
            
            let valData1;
            const valLenBytes1 = len1 * 1;
            if (Array.isArray(val1)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv1 = new DataView(memory0.buffer);
              for (const v of val1) {
                _requireValidNumericPrimitive.bind(null, 'u8')(v);
                dv1.setUint8(ptr1+ offset, v, true);
                offset += 1;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData1 = new Uint8Array(val1.buffer || val1, val1.byteOffset, valLenBytes1);
              const out1 = new Uint8Array(memory0.buffer, ptr1, valLenBytes1);
              out1.set(valData1);
            }
            
            variant2_0 = 1;
            variant2_1 = ptr1;
            variant2_2 = len1;
          }
          var variant4 = v0_1;
          let variant4_0;
          let variant4_1;
          let variant4_2;
          if (variant4 === null || variant4=== undefined) {
            variant4_0 = 0;
            variant4_1 = 0;
            variant4_2 = 0;
          } else {
            const e = variant4;
            var val3 = e;
            var len3 = Array.isArray(val3) ? val3.length : val3.byteLength;
            var ptr3 = realloc0(0, 0, 1, len3 * 1);
            
            let valData3;
            const valLenBytes3 = len3 * 1;
            if (Array.isArray(val3)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv3 = new DataView(memory0.buffer);
              for (const v of val3) {
                _requireValidNumericPrimitive.bind(null, 'u8')(v);
                dv3.setUint8(ptr3+ offset, v, true);
                offset += 1;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData3 = new Uint8Array(val3.buffer || val3, val3.byteOffset, valLenBytes3);
              const out3 = new Uint8Array(memory0.buffer, ptr3, valLenBytes3);
              out3.set(valData3);
            }
            
            variant4_0 = 1;
            variant4_1 = ptr3;
            variant4_2 = len3;
          }
          var variant6 = v0_2;
          let variant6_0;
          let variant6_1;
          let variant6_2;
          if (variant6 === null || variant6=== undefined) {
            variant6_0 = 0;
            variant6_1 = 0;
            variant6_2 = 0;
          } else {
            const e = variant6;
            var val5 = e;
            var len5 = Array.isArray(val5) ? val5.length : val5.byteLength;
            var ptr5 = realloc0(0, 0, 1, len5 * 1);
            
            let valData5;
            const valLenBytes5 = len5 * 1;
            if (Array.isArray(val5)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv5 = new DataView(memory0.buffer);
              for (const v of val5) {
                _requireValidNumericPrimitive.bind(null, 'u8')(v);
                dv5.setUint8(ptr5+ offset, v, true);
                offset += 1;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData5 = new Uint8Array(val5.buffer || val5, val5.byteOffset, valLenBytes5);
              const out5 = new Uint8Array(memory0.buffer, ptr5, valLenBytes5);
              out5.set(valData5);
            }
            
            variant6_0 = 1;
            variant6_1 = ptr5;
            variant6_2 = len5;
          }
          _debugLog('[iface="z:gate-contract/contracts@0.1.0", function="spend"][Instruction::CallWasm] enter', {
            funcName: 'spend',
            paramCount: 9,
            async: false,
            postReturn: true,
          });
          
          let ret;
          
          try {
            ret =  contracts010Spend(variant2_0, variant2_1, variant2_2, variant4_0, variant4_1, variant4_2, variant6_0, variant6_1, variant6_2);
          } catch (err) {
            
            _debugLog('[Instruction::CallWasm] error during sync call', {
              taskID: task.id(),
              err,
            });
            getOrCreateAsyncState(0).markTrapped(err);
            task.setErrored(err);
            task.reject(err);
            task.exit();
            throw err;
            
          }
          
          let variant9;
          switch (dataView(memory0).getUint8(ret + 0, true)) {
            case 0: {
              var ptr7 = dataView(memory0).getUint32(ret + 4, true);
              var len7 = dataView(memory0).getUint32(ret + 8, true);
              if (ptr7 % 1 !== 0) throw new TypeError(`list pointer [${ptr7}] is not aligned to 1`);
              var result7 = new Uint8Array(memory0.buffer.slice(ptr7, ptr7 + len7 * 1));
              variant9= {
                tag: 'ok',
                val: result7
              };
              break;
            }
            case 1: {
              var ptr8 = dataView(memory0).getUint32(ret + 4, true);
              var len8 = dataView(memory0).getUint32(ret + 8, true);
              var result8 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr8, len8));
              variant9= {
                tag: 'err',
                val: result8
              };
              break;
            }
            default: {
              throw new TypeError('invalid variant discriminant for expected');
            }
          }
          _debugLog('[iface="z:gate-contract/contracts@0.1.0", function="spend"][Instruction::Return]', {
            funcName: 'spend',
            paramCount: 1,
            async: false,
            postReturn: true
          });
          const retCopy = variant9;
          task.resolve([retCopy.val]);
          
          let cstate = getOrCreateAsyncState(0);
          cstate.mayLeave = false;
          postReturn0(ret);
          cstate.mayLeave = true;
          task.exit();
          
          
          
          if (typeof retCopy === 'object' && retCopy.tag === 'err') {
            throw new ComponentError(retCopy.val);
          }
          return retCopy.val;
          
          
        } catch (err) {
          if (!task.isResolvedState()) {
            task.setErrored(err);
            task.reject(err);
          }
          if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
          throw err;
        }
      },
    });
    
  }
  let contracts010DispatchAction;
  
  function dispatchAction(arg0) {
    
    const hostProvided = false;
    getOrCreateAsyncState(0).throwIfTrapped();
    
    const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
      componentIdx: 0,
      isAsync: false,
      isManualAsync: false,
      preserveFutureResult: false,
      entryFnName: 'contracts010DispatchAction',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'throw-result-err',
      callingWasmExport: true,
    });
    
    const started = task.enterSync();
    
    if (0!== null) {
      task.setReturnMemoryIdx(0);
      task.setReturnMemory(() => memory0());
    }
    
    
    return _withGlobalCurrentTaskMeta({
      taskID: task.id(),
      componentIdx: task.componentIdx(),
      fn: () => {
        try {
          
          var {input: v0_0, userProfile: v0_1, context: v0_2 } = arg0;
          var variant2 = v0_0;
          let variant2_0;
          let variant2_1;
          let variant2_2;
          if (variant2 === null || variant2=== undefined) {
            variant2_0 = 0;
            variant2_1 = 0;
            variant2_2 = 0;
          } else {
            const e = variant2;
            var val1 = e;
            var len1 = Array.isArray(val1) ? val1.length : val1.byteLength;
            var ptr1 = realloc0(0, 0, 1, len1 * 1);
            
            let valData1;
            const valLenBytes1 = len1 * 1;
            if (Array.isArray(val1)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv1 = new DataView(memory0.buffer);
              for (const v of val1) {
                _requireValidNumericPrimitive.bind(null, 'u8')(v);
                dv1.setUint8(ptr1+ offset, v, true);
                offset += 1;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData1 = new Uint8Array(val1.buffer || val1, val1.byteOffset, valLenBytes1);
              const out1 = new Uint8Array(memory0.buffer, ptr1, valLenBytes1);
              out1.set(valData1);
            }
            
            variant2_0 = 1;
            variant2_1 = ptr1;
            variant2_2 = len1;
          }
          var variant4 = v0_1;
          let variant4_0;
          let variant4_1;
          let variant4_2;
          if (variant4 === null || variant4=== undefined) {
            variant4_0 = 0;
            variant4_1 = 0;
            variant4_2 = 0;
          } else {
            const e = variant4;
            var val3 = e;
            var len3 = Array.isArray(val3) ? val3.length : val3.byteLength;
            var ptr3 = realloc0(0, 0, 1, len3 * 1);
            
            let valData3;
            const valLenBytes3 = len3 * 1;
            if (Array.isArray(val3)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv3 = new DataView(memory0.buffer);
              for (const v of val3) {
                _requireValidNumericPrimitive.bind(null, 'u8')(v);
                dv3.setUint8(ptr3+ offset, v, true);
                offset += 1;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData3 = new Uint8Array(val3.buffer || val3, val3.byteOffset, valLenBytes3);
              const out3 = new Uint8Array(memory0.buffer, ptr3, valLenBytes3);
              out3.set(valData3);
            }
            
            variant4_0 = 1;
            variant4_1 = ptr3;
            variant4_2 = len3;
          }
          var variant6 = v0_2;
          let variant6_0;
          let variant6_1;
          let variant6_2;
          if (variant6 === null || variant6=== undefined) {
            variant6_0 = 0;
            variant6_1 = 0;
            variant6_2 = 0;
          } else {
            const e = variant6;
            var val5 = e;
            var len5 = Array.isArray(val5) ? val5.length : val5.byteLength;
            var ptr5 = realloc0(0, 0, 1, len5 * 1);
            
            let valData5;
            const valLenBytes5 = len5 * 1;
            if (Array.isArray(val5)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv5 = new DataView(memory0.buffer);
              for (const v of val5) {
                _requireValidNumericPrimitive.bind(null, 'u8')(v);
                dv5.setUint8(ptr5+ offset, v, true);
                offset += 1;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData5 = new Uint8Array(val5.buffer || val5, val5.byteOffset, valLenBytes5);
              const out5 = new Uint8Array(memory0.buffer, ptr5, valLenBytes5);
              out5.set(valData5);
            }
            
            variant6_0 = 1;
            variant6_1 = ptr5;
            variant6_2 = len5;
          }
          _debugLog('[iface="z:gate-contract/contracts@0.1.0", function="dispatch-action"][Instruction::CallWasm] enter', {
            funcName: 'dispatch-action',
            paramCount: 9,
            async: false,
            postReturn: true,
          });
          
          let ret;
          
          try {
            ret =  contracts010DispatchAction(variant2_0, variant2_1, variant2_2, variant4_0, variant4_1, variant4_2, variant6_0, variant6_1, variant6_2);
          } catch (err) {
            
            _debugLog('[Instruction::CallWasm] error during sync call', {
              taskID: task.id(),
              err,
            });
            getOrCreateAsyncState(0).markTrapped(err);
            task.setErrored(err);
            task.reject(err);
            task.exit();
            throw err;
            
          }
          
          let variant9;
          switch (dataView(memory0).getUint8(ret + 0, true)) {
            case 0: {
              var ptr7 = dataView(memory0).getUint32(ret + 4, true);
              var len7 = dataView(memory0).getUint32(ret + 8, true);
              if (ptr7 % 1 !== 0) throw new TypeError(`list pointer [${ptr7}] is not aligned to 1`);
              var result7 = new Uint8Array(memory0.buffer.slice(ptr7, ptr7 + len7 * 1));
              variant9= {
                tag: 'ok',
                val: result7
              };
              break;
            }
            case 1: {
              var ptr8 = dataView(memory0).getUint32(ret + 4, true);
              var len8 = dataView(memory0).getUint32(ret + 8, true);
              var result8 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr8, len8));
              variant9= {
                tag: 'err',
                val: result8
              };
              break;
            }
            default: {
              throw new TypeError('invalid variant discriminant for expected');
            }
          }
          _debugLog('[iface="z:gate-contract/contracts@0.1.0", function="dispatch-action"][Instruction::Return]', {
            funcName: 'dispatch-action',
            paramCount: 1,
            async: false,
            postReturn: true
          });
          const retCopy = variant9;
          task.resolve([retCopy.val]);
          
          let cstate = getOrCreateAsyncState(0);
          cstate.mayLeave = false;
          postReturn0(ret);
          cstate.mayLeave = true;
          task.exit();
          
          
          
          if (typeof retCopy === 'object' && retCopy.tag === 'err') {
            throw new ComponentError(retCopy.val);
          }
          return retCopy.val;
          
          
        } catch (err) {
          if (!task.isResolvedState()) {
            task.setErrored(err);
            task.reject(err);
          }
          if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
          throw err;
        }
      },
    });
    
  }
  let contracts010ExecuteAction;
  
  function executeAction(arg0) {
    
    const hostProvided = false;
    getOrCreateAsyncState(0).throwIfTrapped();
    
    const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
      componentIdx: 0,
      isAsync: false,
      isManualAsync: false,
      preserveFutureResult: false,
      entryFnName: 'contracts010ExecuteAction',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'throw-result-err',
      callingWasmExport: true,
    });
    
    const started = task.enterSync();
    
    if (0!== null) {
      task.setReturnMemoryIdx(0);
      task.setReturnMemory(() => memory0());
    }
    
    
    return _withGlobalCurrentTaskMeta({
      taskID: task.id(),
      componentIdx: task.componentIdx(),
      fn: () => {
        try {
          
          var {input: v0_0, userProfile: v0_1, context: v0_2 } = arg0;
          var variant2 = v0_0;
          let variant2_0;
          let variant2_1;
          let variant2_2;
          if (variant2 === null || variant2=== undefined) {
            variant2_0 = 0;
            variant2_1 = 0;
            variant2_2 = 0;
          } else {
            const e = variant2;
            var val1 = e;
            var len1 = Array.isArray(val1) ? val1.length : val1.byteLength;
            var ptr1 = realloc0(0, 0, 1, len1 * 1);
            
            let valData1;
            const valLenBytes1 = len1 * 1;
            if (Array.isArray(val1)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv1 = new DataView(memory0.buffer);
              for (const v of val1) {
                _requireValidNumericPrimitive.bind(null, 'u8')(v);
                dv1.setUint8(ptr1+ offset, v, true);
                offset += 1;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData1 = new Uint8Array(val1.buffer || val1, val1.byteOffset, valLenBytes1);
              const out1 = new Uint8Array(memory0.buffer, ptr1, valLenBytes1);
              out1.set(valData1);
            }
            
            variant2_0 = 1;
            variant2_1 = ptr1;
            variant2_2 = len1;
          }
          var variant4 = v0_1;
          let variant4_0;
          let variant4_1;
          let variant4_2;
          if (variant4 === null || variant4=== undefined) {
            variant4_0 = 0;
            variant4_1 = 0;
            variant4_2 = 0;
          } else {
            const e = variant4;
            var val3 = e;
            var len3 = Array.isArray(val3) ? val3.length : val3.byteLength;
            var ptr3 = realloc0(0, 0, 1, len3 * 1);
            
            let valData3;
            const valLenBytes3 = len3 * 1;
            if (Array.isArray(val3)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv3 = new DataView(memory0.buffer);
              for (const v of val3) {
                _requireValidNumericPrimitive.bind(null, 'u8')(v);
                dv3.setUint8(ptr3+ offset, v, true);
                offset += 1;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData3 = new Uint8Array(val3.buffer || val3, val3.byteOffset, valLenBytes3);
              const out3 = new Uint8Array(memory0.buffer, ptr3, valLenBytes3);
              out3.set(valData3);
            }
            
            variant4_0 = 1;
            variant4_1 = ptr3;
            variant4_2 = len3;
          }
          var variant6 = v0_2;
          let variant6_0;
          let variant6_1;
          let variant6_2;
          if (variant6 === null || variant6=== undefined) {
            variant6_0 = 0;
            variant6_1 = 0;
            variant6_2 = 0;
          } else {
            const e = variant6;
            var val5 = e;
            var len5 = Array.isArray(val5) ? val5.length : val5.byteLength;
            var ptr5 = realloc0(0, 0, 1, len5 * 1);
            
            let valData5;
            const valLenBytes5 = len5 * 1;
            if (Array.isArray(val5)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv5 = new DataView(memory0.buffer);
              for (const v of val5) {
                _requireValidNumericPrimitive.bind(null, 'u8')(v);
                dv5.setUint8(ptr5+ offset, v, true);
                offset += 1;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData5 = new Uint8Array(val5.buffer || val5, val5.byteOffset, valLenBytes5);
              const out5 = new Uint8Array(memory0.buffer, ptr5, valLenBytes5);
              out5.set(valData5);
            }
            
            variant6_0 = 1;
            variant6_1 = ptr5;
            variant6_2 = len5;
          }
          _debugLog('[iface="z:gate-contract/contracts@0.1.0", function="execute-action"][Instruction::CallWasm] enter', {
            funcName: 'execute-action',
            paramCount: 9,
            async: false,
            postReturn: true,
          });
          
          let ret;
          
          try {
            ret =  contracts010ExecuteAction(variant2_0, variant2_1, variant2_2, variant4_0, variant4_1, variant4_2, variant6_0, variant6_1, variant6_2);
          } catch (err) {
            
            _debugLog('[Instruction::CallWasm] error during sync call', {
              taskID: task.id(),
              err,
            });
            getOrCreateAsyncState(0).markTrapped(err);
            task.setErrored(err);
            task.reject(err);
            task.exit();
            throw err;
            
          }
          
          let variant9;
          switch (dataView(memory0).getUint8(ret + 0, true)) {
            case 0: {
              var ptr7 = dataView(memory0).getUint32(ret + 4, true);
              var len7 = dataView(memory0).getUint32(ret + 8, true);
              if (ptr7 % 1 !== 0) throw new TypeError(`list pointer [${ptr7}] is not aligned to 1`);
              var result7 = new Uint8Array(memory0.buffer.slice(ptr7, ptr7 + len7 * 1));
              variant9= {
                tag: 'ok',
                val: result7
              };
              break;
            }
            case 1: {
              var ptr8 = dataView(memory0).getUint32(ret + 4, true);
              var len8 = dataView(memory0).getUint32(ret + 8, true);
              var result8 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr8, len8));
              variant9= {
                tag: 'err',
                val: result8
              };
              break;
            }
            default: {
              throw new TypeError('invalid variant discriminant for expected');
            }
          }
          _debugLog('[iface="z:gate-contract/contracts@0.1.0", function="execute-action"][Instruction::Return]', {
            funcName: 'execute-action',
            paramCount: 1,
            async: false,
            postReturn: true
          });
          const retCopy = variant9;
          task.resolve([retCopy.val]);
          
          let cstate = getOrCreateAsyncState(0);
          cstate.mayLeave = false;
          postReturn0(ret);
          cstate.mayLeave = true;
          task.exit();
          
          
          
          if (typeof retCopy === 'object' && retCopy.tag === 'err') {
            throw new ComponentError(retCopy.val);
          }
          return retCopy.val;
          
          
        } catch (err) {
          if (!task.isResolvedState()) {
            task.setErrored(err);
            task.reject(err);
          }
          if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
          throw err;
        }
      },
    });
    
  }
  let trampoline0 = _trampoline0.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 0,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline0.manuallyAsync,
    paramLiftFns: [],
    resultLowerFns: [_lowerFlatU64],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline0,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 0,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline0.manuallyAsync,
    paramLiftFns: [],
    resultLowerFns: [_lowerFlatU64],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline0,
  },
  );
  function trampoline1(handle) {
    const handleEntry = rscTableRemove(handleTable1, handle);
    if (handleEntry.own) {
      
      const rsc = captureTable1.get(handleEntry.rep);
      if (rsc) {
        if (rsc[symbolDispose]) rsc[symbolDispose]();
        captureTable1.delete(handleEntry.rep);
      } else if (Error$1[symbolCabiDispose]) {
        Error$1[symbolCabiDispose](handleEntry.rep);
      }
    }
  }
  function trampoline2(handle) {
    const handleEntry = rscTableRemove(handleTable0, handle);
    if (handleEntry.own) {
      
      const rsc = captureTable0.get(handleEntry.rep);
      if (rsc) {
        if (rsc[symbolDispose]) rsc[symbolDispose]();
        captureTable0.delete(handleEntry.rep);
      } else if (Pollable[symbolCabiDispose]) {
        Pollable[symbolCabiDispose](handleEntry.rep);
      }
    }
  }
  function trampoline3(handle) {
    const handleEntry = rscTableRemove(handleTable2, handle);
    if (handleEntry.own) {
      
      const rsc = captureTable2.get(handleEntry.rep);
      if (rsc) {
        if (rsc[symbolDispose]) rsc[symbolDispose]();
        captureTable2.delete(handleEntry.rep);
      } else if (InputStream[symbolCabiDispose]) {
        InputStream[symbolCabiDispose](handleEntry.rep);
      }
    }
  }
  function trampoline4(handle) {
    const handleEntry = rscTableRemove(handleTable3, handle);
    if (handleEntry.own) {
      
      const rsc = captureTable3.get(handleEntry.rep);
      if (rsc) {
        if (rsc[symbolDispose]) rsc[symbolDispose]();
        captureTable3.delete(handleEntry.rep);
      } else if (OutputStream[symbolCabiDispose]) {
        OutputStream[symbolCabiDispose](handleEntry.rep);
      }
    }
  }
  function trampoline5(handle) {
    const handleEntry = rscTableRemove(handleTable4, handle);
    if (handleEntry.own) {
      
      const rsc = captureTable4.get(handleEntry.rep);
      if (rsc) {
        if (rsc[symbolDispose]) rsc[symbolDispose]();
        captureTable4.delete(handleEntry.rep);
      } else if (TerminalInput[symbolCabiDispose]) {
        TerminalInput[symbolCabiDispose](handleEntry.rep);
      }
    }
  }
  function trampoline6(handle) {
    const handleEntry = rscTableRemove(handleTable5, handle);
    if (handleEntry.own) {
      
      const rsc = captureTable5.get(handleEntry.rep);
      if (rsc) {
        if (rsc[symbolDispose]) rsc[symbolDispose]();
        captureTable5.delete(handleEntry.rep);
      } else if (TerminalOutput[symbolCabiDispose]) {
        TerminalOutput[symbolCabiDispose](handleEntry.rep);
      }
    }
  }
  let trampoline7 = _trampoline7.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 7,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline7.manuallyAsync,
    paramLiftFns: [
    _liftFlatResult({
      caseMetas: [['ok', null, 0, 0, 0, []],['err', null, 0, 0, 0, []],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
      variantPayloadFlatTypes: [],
    })
    ],
    resultLowerFns: [],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline7,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 7,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline7.manuallyAsync,
    paramLiftFns: [
    _liftFlatResult({
      caseMetas: [['ok', null, 0, 0, 0, []],['err', null, 0, 0, 0, []],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
      variantPayloadFlatTypes: [],
    })
    ],
    resultLowerFns: [],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline7,
  },
  );
  let trampoline8 = _trampoline8.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 8,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline8.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 0)],
    resultLowerFns: [],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline8,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 8,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline8.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 0)],
    resultLowerFns: [],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline8,
  },
  );
  let trampoline9 = _trampoline9.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 9,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline9.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 3)],
    resultLowerFns: [_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_Pollable(obj) {
        if (!(obj instanceof Pollable)) {
          throw new TypeError('Resource error: Not a valid \"Pollable\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt0;
          captureTable0.set(rep, obj);
          handle = rscTableCreateOwn(handleTable0, rep);
        }
        return handle;
      }
      ,
    })],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline9,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 9,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline9.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 3)],
    resultLowerFns: [_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_Pollable(obj) {
        if (!(obj instanceof Pollable)) {
          throw new TypeError('Resource error: Not a valid \"Pollable\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt0;
          captureTable0.set(rep, obj);
          handle = rscTableCreateOwn(handleTable0, rep);
        }
        return handle;
      }
      ,
    })],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline9,
  },
  );
  let trampoline10 = _trampoline10.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 10,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline10.manuallyAsync,
    paramLiftFns: [],
    resultLowerFns: [_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_InputStream(obj) {
        if (!(obj instanceof InputStream)) {
          throw new TypeError('Resource error: Not a valid \"InputStream\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt2;
          captureTable2.set(rep, obj);
          handle = rscTableCreateOwn(handleTable2, rep);
        }
        return handle;
      }
      ,
    })],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline10,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 10,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline10.manuallyAsync,
    paramLiftFns: [],
    resultLowerFns: [_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_InputStream(obj) {
        if (!(obj instanceof InputStream)) {
          throw new TypeError('Resource error: Not a valid \"InputStream\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt2;
          captureTable2.set(rep, obj);
          handle = rscTableCreateOwn(handleTable2, rep);
        }
        return handle;
      }
      ,
    })],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline10,
  },
  );
  let trampoline11 = _trampoline11.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 11,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline11.manuallyAsync,
    paramLiftFns: [],
    resultLowerFns: [_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_OutputStream(obj) {
        if (!(obj instanceof OutputStream)) {
          throw new TypeError('Resource error: Not a valid \"OutputStream\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt3;
          captureTable3.set(rep, obj);
          handle = rscTableCreateOwn(handleTable3, rep);
        }
        return handle;
      }
      ,
    })],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline11,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 11,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline11.manuallyAsync,
    paramLiftFns: [],
    resultLowerFns: [_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_OutputStream(obj) {
        if (!(obj instanceof OutputStream)) {
          throw new TypeError('Resource error: Not a valid \"OutputStream\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt3;
          captureTable3.set(rep, obj);
          handle = rscTableCreateOwn(handleTable3, rep);
        }
        return handle;
      }
      ,
    })],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline11,
  },
  );
  let trampoline12 = _trampoline12.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 12,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline12.manuallyAsync,
    paramLiftFns: [],
    resultLowerFns: [_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_OutputStream(obj) {
        if (!(obj instanceof OutputStream)) {
          throw new TypeError('Resource error: Not a valid \"OutputStream\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt3;
          captureTable3.set(rep, obj);
          handle = rscTableCreateOwn(handleTable3, rep);
        }
        return handle;
      }
      ,
    })],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline12,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 12,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline12.manuallyAsync,
    paramLiftFns: [],
    resultLowerFns: [_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_OutputStream(obj) {
        if (!(obj instanceof OutputStream)) {
          throw new TypeError('Resource error: Not a valid \"OutputStream\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt3;
          captureTable3.set(rep, obj);
          handle = rscTableCreateOwn(handleTable3, rep);
        }
        return handle;
      }
      ,
    })],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline12,
  },
  );
  let trampoline13 = _trampoline13.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 13,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline13.manuallyAsync,
    paramLiftFns: [_liftFlatStringAny],
    resultLowerFns: [
    _lowerFlatResult({
      caseMetas: [
      [ 'ok', null, 12, 4, 4 ],
      [ 'err', _lowerFlatStringAny, 12, 4, 4 ],
      ],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
    })
    ],
    hasResultPointer: true,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: () => realloc0,
    importFn: _trampoline13,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 13,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline13.manuallyAsync,
    paramLiftFns: [_liftFlatStringAny],
    resultLowerFns: [
    _lowerFlatResult({
      caseMetas: [
      [ 'ok', null, 12, 4, 4 ],
      [ 'err', _lowerFlatStringAny, 12, 4, 4 ],
      ],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
    })
    ],
    hasResultPointer: true,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: () => realloc0,
    importFn: _trampoline13,
  },
  );
  let trampoline14 = _trampoline14.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 14,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline14.manuallyAsync,
    paramLiftFns: [],
    resultLowerFns: [_lowerFlatList({
      elemLowerFn: _lowerFlatU8,
      elemSize32: 1,
      elemAlign32: 1,
    })],
    hasResultPointer: true,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: () => realloc0,
    importFn: _trampoline14,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 14,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline14.manuallyAsync,
    paramLiftFns: [],
    resultLowerFns: [_lowerFlatList({
      elemLowerFn: _lowerFlatU8,
      elemSize32: 1,
      elemAlign32: 1,
    })],
    hasResultPointer: true,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: () => realloc0,
    importFn: _trampoline14,
  },
  );
  let trampoline15 = _trampoline15.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 15,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline15.manuallyAsync,
    paramLiftFns: [_liftFlatStringAny,_liftFlatList({
      elemLiftFn: _liftFlatU8,
      elemAlign32: 1,
      elemSize32: 1,
      typedArray: Uint8Array,
    }),_liftFlatList({
      elemLiftFn: _liftFlatU8,
      elemAlign32: 1,
      elemSize32: 1,
      typedArray: Uint8Array,
    })],
    resultLowerFns: [
    _lowerFlatResult({
      caseMetas: [
      [ 'ok', null, 12, 4, 4 ],
      [ 'err', _lowerFlatStringAny, 12, 4, 4 ],
      ],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
    })
    ],
    hasResultPointer: true,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: () => realloc0,
    importFn: _trampoline15,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 15,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline15.manuallyAsync,
    paramLiftFns: [_liftFlatStringAny,_liftFlatList({
      elemLiftFn: _liftFlatU8,
      elemAlign32: 1,
      elemSize32: 1,
      typedArray: Uint8Array,
    }),_liftFlatList({
      elemLiftFn: _liftFlatU8,
      elemAlign32: 1,
      elemSize32: 1,
      typedArray: Uint8Array,
    })],
    resultLowerFns: [
    _lowerFlatResult({
      caseMetas: [
      [ 'ok', null, 12, 4, 4 ],
      [ 'err', _lowerFlatStringAny, 12, 4, 4 ],
      ],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
    })
    ],
    hasResultPointer: true,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: () => realloc0,
    importFn: _trampoline15,
  },
  );
  let trampoline16 = _trampoline16.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 16,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline16.manuallyAsync,
    paramLiftFns: [_liftFlatStringAny,_liftFlatList({
      elemLiftFn: _liftFlatU8,
      elemAlign32: 1,
      elemSize32: 1,
      typedArray: Uint8Array,
    })],
    resultLowerFns: [
    _lowerFlatResult({
      caseMetas: [
      [ 'ok', 
      _lowerFlatOption({
        caseMetas: [
        [ 'none', null, 0, 0, 0 ],
        [ 'some', _lowerFlatList({
          elemLowerFn: _lowerFlatU8,
          elemSize32: 1,
          elemAlign32: 1,
        }), 8, 4, 2],
        ],
        variantSize32: 12,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 3,
      })
      , 16, 4, 4 ],
      [ 'err', _lowerFlatStringAny, 16, 4, 4 ],
      ],
      variantSize32: 16,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 4,
    })
    ],
    hasResultPointer: true,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: () => realloc0,
    importFn: _trampoline16,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 16,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline16.manuallyAsync,
    paramLiftFns: [_liftFlatStringAny,_liftFlatList({
      elemLiftFn: _liftFlatU8,
      elemAlign32: 1,
      elemSize32: 1,
      typedArray: Uint8Array,
    })],
    resultLowerFns: [
    _lowerFlatResult({
      caseMetas: [
      [ 'ok', 
      _lowerFlatOption({
        caseMetas: [
        [ 'none', null, 0, 0, 0 ],
        [ 'some', _lowerFlatList({
          elemLowerFn: _lowerFlatU8,
          elemSize32: 1,
          elemAlign32: 1,
        }), 8, 4, 2],
        ],
        variantSize32: 12,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 3,
      })
      , 16, 4, 4 ],
      [ 'err', _lowerFlatStringAny, 16, 4, 4 ],
      ],
      variantSize32: 16,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 4,
    })
    ],
    hasResultPointer: true,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: () => realloc0,
    importFn: _trampoline16,
  },
  );
  let trampoline17 = _trampoline17.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 17,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline17.manuallyAsync,
    paramLiftFns: [_liftFlatRecord({ fieldMetas: [['method', 
    _liftFlatEnum({
      caseMetas: [['get', null, 1, 1, 1],['post', null, 1, 1, 1],['put', null, 1, 1, 1],['patch', null, 1, 1, 1],['delete', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 1, 1],['url', _liftFlatStringAny, 8, 4],['headers', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatList({
        elemLiftFn: _liftFlatTuple({ elemLiftFns: [[_liftFlatStringAny, 8, 4],[_liftFlatStringAny, 8, 4],], size32: 16, align32: 4 }),
        elemAlign32: 4,
        elemSize32: 16,
        typedArray: undefined,
      }), 8, 4, 2, ['i32','i32'] ],
      ],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
      variantPayloadFlatTypes: ['i32','i32'],
    })
    , 12, 4],['payload', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatList({
        elemLiftFn: _liftFlatU8,
        elemAlign32: 1,
        elemSize32: 1,
        typedArray: Uint8Array,
      }), 8, 4, 2, ['i32','i32'] ],
      ],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
      variantPayloadFlatTypes: ['i32','i32'],
    })
    , 12, 4],], size32: 36, align32: 4 })],
    resultLowerFns: [
    _lowerFlatResult({
      caseMetas: [
      [ 'ok', _lowerFlatRecord({ fieldMetas: [['code', _lowerFlatU16, 2, 2 ],['payload', _lowerFlatList({
        elemLowerFn: _lowerFlatU8,
        elemSize32: 1,
        elemAlign32: 1,
      }), 8, 4 ],], size32: 12, align32: 4 }), 16, 4, 4 ],
      [ 'err', _lowerFlatVariant({
        caseMetas: [[ 'egress-denied', _lowerFlatStringAny, 8, 4, 2 ],[ 'placeholder-denied', _lowerFlatStringAny, 8, 4, 2 ],[ 'placeholder-unknown', _lowerFlatStringAny, 8, 4, 2 ],[ 'placeholder-no-user-context', null, 0, 0, 0 ],[ 'upstream-error', _lowerFlatStringAny, 8, 4, 2 ],],
        variantSize32: 12,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 3,
      } ), 16, 4, 4 ],
      ],
      variantSize32: 16,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 4,
    })
    ],
    hasResultPointer: true,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: () => realloc0,
    importFn: _trampoline17,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 17,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline17.manuallyAsync,
    paramLiftFns: [_liftFlatRecord({ fieldMetas: [['method', 
    _liftFlatEnum({
      caseMetas: [['get', null, 1, 1, 1],['post', null, 1, 1, 1],['put', null, 1, 1, 1],['patch', null, 1, 1, 1],['delete', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 1, 1],['url', _liftFlatStringAny, 8, 4],['headers', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatList({
        elemLiftFn: _liftFlatTuple({ elemLiftFns: [[_liftFlatStringAny, 8, 4],[_liftFlatStringAny, 8, 4],], size32: 16, align32: 4 }),
        elemAlign32: 4,
        elemSize32: 16,
        typedArray: undefined,
      }), 8, 4, 2, ['i32','i32'] ],
      ],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
      variantPayloadFlatTypes: ['i32','i32'],
    })
    , 12, 4],['payload', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatList({
        elemLiftFn: _liftFlatU8,
        elemAlign32: 1,
        elemSize32: 1,
        typedArray: Uint8Array,
      }), 8, 4, 2, ['i32','i32'] ],
      ],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
      variantPayloadFlatTypes: ['i32','i32'],
    })
    , 12, 4],], size32: 36, align32: 4 })],
    resultLowerFns: [
    _lowerFlatResult({
      caseMetas: [
      [ 'ok', _lowerFlatRecord({ fieldMetas: [['code', _lowerFlatU16, 2, 2 ],['payload', _lowerFlatList({
        elemLowerFn: _lowerFlatU8,
        elemSize32: 1,
        elemAlign32: 1,
      }), 8, 4 ],], size32: 12, align32: 4 }), 16, 4, 4 ],
      [ 'err', _lowerFlatVariant({
        caseMetas: [[ 'egress-denied', _lowerFlatStringAny, 8, 4, 2 ],[ 'placeholder-denied', _lowerFlatStringAny, 8, 4, 2 ],[ 'placeholder-unknown', _lowerFlatStringAny, 8, 4, 2 ],[ 'placeholder-no-user-context', null, 0, 0, 0 ],[ 'upstream-error', _lowerFlatStringAny, 8, 4, 2 ],],
        variantSize32: 12,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 3,
      } ), 16, 4, 4 ],
      ],
      variantSize32: 16,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 4,
    })
    ],
    hasResultPointer: true,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: () => realloc0,
    importFn: _trampoline17,
  },
  );
  let trampoline18 = _trampoline18.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 18,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline18.manuallyAsync,
    paramLiftFns: [_liftFlatRecord({ fieldMetas: [['method', 
    _liftFlatEnum({
      caseMetas: [['get', null, 1, 1, 1],['post', null, 1, 1, 1],['put', null, 1, 1, 1],['patch', null, 1, 1, 1],['delete', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 1, 1],['url', _liftFlatStringAny, 8, 4],['headers', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatList({
        elemLiftFn: _liftFlatTuple({ elemLiftFns: [[_liftFlatStringAny, 8, 4],[_liftFlatStringAny, 8, 4],], size32: 16, align32: 4 }),
        elemAlign32: 4,
        elemSize32: 16,
        typedArray: undefined,
      }), 8, 4, 2, ['i32','i32'] ],
      ],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
      variantPayloadFlatTypes: ['i32','i32'],
    })
    , 12, 4],['payload', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatList({
        elemLiftFn: _liftFlatU8,
        elemAlign32: 1,
        elemSize32: 1,
        typedArray: Uint8Array,
      }), 8, 4, 2, ['i32','i32'] ],
      ],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
      variantPayloadFlatTypes: ['i32','i32'],
    })
    , 12, 4],], size32: 36, align32: 4 })],
    resultLowerFns: [
    _lowerFlatResult({
      caseMetas: [
      [ 'ok', _lowerFlatRecord({ fieldMetas: [['code', _lowerFlatU16, 2, 2 ],['payload', _lowerFlatList({
        elemLowerFn: _lowerFlatU8,
        elemSize32: 1,
        elemAlign32: 1,
      }), 8, 4 ],], size32: 12, align32: 4 }), 16, 4, 4 ],
      [ 'err', _lowerFlatStringAny, 16, 4, 4 ],
      ],
      variantSize32: 16,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 4,
    })
    ],
    hasResultPointer: true,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: () => realloc0,
    importFn: _trampoline18,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 18,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline18.manuallyAsync,
    paramLiftFns: [_liftFlatRecord({ fieldMetas: [['method', 
    _liftFlatEnum({
      caseMetas: [['get', null, 1, 1, 1],['post', null, 1, 1, 1],['put', null, 1, 1, 1],['patch', null, 1, 1, 1],['delete', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 1, 1],['url', _liftFlatStringAny, 8, 4],['headers', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatList({
        elemLiftFn: _liftFlatTuple({ elemLiftFns: [[_liftFlatStringAny, 8, 4],[_liftFlatStringAny, 8, 4],], size32: 16, align32: 4 }),
        elemAlign32: 4,
        elemSize32: 16,
        typedArray: undefined,
      }), 8, 4, 2, ['i32','i32'] ],
      ],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
      variantPayloadFlatTypes: ['i32','i32'],
    })
    , 12, 4],['payload', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatList({
        elemLiftFn: _liftFlatU8,
        elemAlign32: 1,
        elemSize32: 1,
        typedArray: Uint8Array,
      }), 8, 4, 2, ['i32','i32'] ],
      ],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
      variantPayloadFlatTypes: ['i32','i32'],
    })
    , 12, 4],], size32: 36, align32: 4 })],
    resultLowerFns: [
    _lowerFlatResult({
      caseMetas: [
      [ 'ok', _lowerFlatRecord({ fieldMetas: [['code', _lowerFlatU16, 2, 2 ],['payload', _lowerFlatList({
        elemLowerFn: _lowerFlatU8,
        elemSize32: 1,
        elemAlign32: 1,
      }), 8, 4 ],], size32: 12, align32: 4 }), 16, 4, 4 ],
      [ 'err', _lowerFlatStringAny, 16, 4, 4 ],
      ],
      variantSize32: 16,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 4,
    })
    ],
    hasResultPointer: true,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: () => realloc0,
    importFn: _trampoline18,
  },
  );
  let trampoline19 = _trampoline19.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 19,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline19.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 3)],
    resultLowerFns: [
    _lowerFlatResult({
      caseMetas: [
      [ 'ok', _lowerFlatU64, 16, 8, 8 ],
      [ 'err', _lowerFlatVariant({
        caseMetas: [[ 'last-operation-failed', _lowerFlatOwn({
          componentIdx: 0,
          lowerFn: 
          function lowerImportedOwnedHost_Error$1(obj) {
            if (!(obj instanceof Error$1)) {
              throw new TypeError('Resource error: Not a valid \"Error$1\" resource.');
            }
            let handle = obj[symbolRscHandle];
            if (!handle) {
              const rep = obj[symbolRscRep] || ++captureCnt1;
              captureTable1.set(rep, obj);
              handle = rscTableCreateOwn(handleTable1, rep);
            }
            return handle;
          }
          ,
        }), 4, 4, 1 ],[ 'closed', null, 0, 0, 0 ],],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
      } ), 16, 8, 8 ],
      ],
      variantSize32: 16,
      variantAlign32: 8,
      variantPayloadOffset32: 8,
      variantFlatCount: 3,
    })
    ],
    hasResultPointer: true,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline19,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 19,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline19.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 3)],
    resultLowerFns: [
    _lowerFlatResult({
      caseMetas: [
      [ 'ok', _lowerFlatU64, 16, 8, 8 ],
      [ 'err', _lowerFlatVariant({
        caseMetas: [[ 'last-operation-failed', _lowerFlatOwn({
          componentIdx: 0,
          lowerFn: 
          function lowerImportedOwnedHost_Error$1(obj) {
            if (!(obj instanceof Error$1)) {
              throw new TypeError('Resource error: Not a valid \"Error$1\" resource.');
            }
            let handle = obj[symbolRscHandle];
            if (!handle) {
              const rep = obj[symbolRscRep] || ++captureCnt1;
              captureTable1.set(rep, obj);
              handle = rscTableCreateOwn(handleTable1, rep);
            }
            return handle;
          }
          ,
        }), 4, 4, 1 ],[ 'closed', null, 0, 0, 0 ],],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
      } ), 16, 8, 8 ],
      ],
      variantSize32: 16,
      variantAlign32: 8,
      variantPayloadOffset32: 8,
      variantFlatCount: 3,
    })
    ],
    hasResultPointer: true,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline19,
  },
  );
  let trampoline20 = _trampoline20.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 20,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline20.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 3),_liftFlatList({
      elemLiftFn: _liftFlatU8,
      elemAlign32: 1,
      elemSize32: 1,
      typedArray: Uint8Array,
    })],
    resultLowerFns: [
    _lowerFlatResult({
      caseMetas: [
      [ 'ok', null, 12, 4, 4 ],
      [ 'err', _lowerFlatVariant({
        caseMetas: [[ 'last-operation-failed', _lowerFlatOwn({
          componentIdx: 0,
          lowerFn: 
          function lowerImportedOwnedHost_Error$1(obj) {
            if (!(obj instanceof Error$1)) {
              throw new TypeError('Resource error: Not a valid \"Error$1\" resource.');
            }
            let handle = obj[symbolRscHandle];
            if (!handle) {
              const rep = obj[symbolRscRep] || ++captureCnt1;
              captureTable1.set(rep, obj);
              handle = rscTableCreateOwn(handleTable1, rep);
            }
            return handle;
          }
          ,
        }), 4, 4, 1 ],[ 'closed', null, 0, 0, 0 ],],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
      } ), 12, 4, 4 ],
      ],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
    })
    ],
    hasResultPointer: true,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline20,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 20,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline20.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 3),_liftFlatList({
      elemLiftFn: _liftFlatU8,
      elemAlign32: 1,
      elemSize32: 1,
      typedArray: Uint8Array,
    })],
    resultLowerFns: [
    _lowerFlatResult({
      caseMetas: [
      [ 'ok', null, 12, 4, 4 ],
      [ 'err', _lowerFlatVariant({
        caseMetas: [[ 'last-operation-failed', _lowerFlatOwn({
          componentIdx: 0,
          lowerFn: 
          function lowerImportedOwnedHost_Error$1(obj) {
            if (!(obj instanceof Error$1)) {
              throw new TypeError('Resource error: Not a valid \"Error$1\" resource.');
            }
            let handle = obj[symbolRscHandle];
            if (!handle) {
              const rep = obj[symbolRscRep] || ++captureCnt1;
              captureTable1.set(rep, obj);
              handle = rscTableCreateOwn(handleTable1, rep);
            }
            return handle;
          }
          ,
        }), 4, 4, 1 ],[ 'closed', null, 0, 0, 0 ],],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
      } ), 12, 4, 4 ],
      ],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
    })
    ],
    hasResultPointer: true,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline20,
  },
  );
  let trampoline21 = _trampoline21.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 21,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline21.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 3)],
    resultLowerFns: [
    _lowerFlatResult({
      caseMetas: [
      [ 'ok', null, 12, 4, 4 ],
      [ 'err', _lowerFlatVariant({
        caseMetas: [[ 'last-operation-failed', _lowerFlatOwn({
          componentIdx: 0,
          lowerFn: 
          function lowerImportedOwnedHost_Error$1(obj) {
            if (!(obj instanceof Error$1)) {
              throw new TypeError('Resource error: Not a valid \"Error$1\" resource.');
            }
            let handle = obj[symbolRscHandle];
            if (!handle) {
              const rep = obj[symbolRscRep] || ++captureCnt1;
              captureTable1.set(rep, obj);
              handle = rscTableCreateOwn(handleTable1, rep);
            }
            return handle;
          }
          ,
        }), 4, 4, 1 ],[ 'closed', null, 0, 0, 0 ],],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
      } ), 12, 4, 4 ],
      ],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
    })
    ],
    hasResultPointer: true,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline21,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 21,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline21.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 3)],
    resultLowerFns: [
    _lowerFlatResult({
      caseMetas: [
      [ 'ok', null, 12, 4, 4 ],
      [ 'err', _lowerFlatVariant({
        caseMetas: [[ 'last-operation-failed', _lowerFlatOwn({
          componentIdx: 0,
          lowerFn: 
          function lowerImportedOwnedHost_Error$1(obj) {
            if (!(obj instanceof Error$1)) {
              throw new TypeError('Resource error: Not a valid \"Error$1\" resource.');
            }
            let handle = obj[symbolRscHandle];
            if (!handle) {
              const rep = obj[symbolRscRep] || ++captureCnt1;
              captureTable1.set(rep, obj);
              handle = rscTableCreateOwn(handleTable1, rep);
            }
            return handle;
          }
          ,
        }), 4, 4, 1 ],[ 'closed', null, 0, 0, 0 ],],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
      } ), 12, 4, 4 ],
      ],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
    })
    ],
    hasResultPointer: true,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline21,
  },
  );
  let trampoline22 = _trampoline22.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 22,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline22.manuallyAsync,
    paramLiftFns: [],
    resultLowerFns: [_lowerFlatList({
      elemLowerFn: _lowerFlatTuple({ elemLowerMetas: [[_lowerFlatStringAny, 8, 4],[_lowerFlatStringAny, 8, 4],], size32: 16, align32: 4 }),
      elemSize32: 16,
      elemAlign32: 4,
    })],
    hasResultPointer: true,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: () => realloc0,
    importFn: _trampoline22,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 22,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline22.manuallyAsync,
    paramLiftFns: [],
    resultLowerFns: [_lowerFlatList({
      elemLowerFn: _lowerFlatTuple({ elemLowerMetas: [[_lowerFlatStringAny, 8, 4],[_lowerFlatStringAny, 8, 4],], size32: 16, align32: 4 }),
      elemSize32: 16,
      elemAlign32: 4,
    })],
    hasResultPointer: true,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: () => realloc0,
    importFn: _trampoline22,
  },
  );
  let trampoline23 = _trampoline23.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 23,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline23.manuallyAsync,
    paramLiftFns: [],
    resultLowerFns: [
    _lowerFlatOption({
      caseMetas: [
      [ 'none', null, 0, 0, 0 ],
      [ 'some', _lowerFlatOwn({
        componentIdx: 0,
        lowerFn: 
        function lowerImportedOwnedHost_TerminalInput(obj) {
          if (!(obj instanceof TerminalInput)) {
            throw new TypeError('Resource error: Not a valid \"TerminalInput\" resource.');
          }
          let handle = obj[symbolRscHandle];
          if (!handle) {
            const rep = obj[symbolRscRep] || ++captureCnt4;
            captureTable4.set(rep, obj);
            handle = rscTableCreateOwn(handleTable4, rep);
          }
          return handle;
        }
        ,
      }), 4, 4, 1],
      ],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
    })
    ],
    hasResultPointer: true,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline23,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 23,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline23.manuallyAsync,
    paramLiftFns: [],
    resultLowerFns: [
    _lowerFlatOption({
      caseMetas: [
      [ 'none', null, 0, 0, 0 ],
      [ 'some', _lowerFlatOwn({
        componentIdx: 0,
        lowerFn: 
        function lowerImportedOwnedHost_TerminalInput(obj) {
          if (!(obj instanceof TerminalInput)) {
            throw new TypeError('Resource error: Not a valid \"TerminalInput\" resource.');
          }
          let handle = obj[symbolRscHandle];
          if (!handle) {
            const rep = obj[symbolRscRep] || ++captureCnt4;
            captureTable4.set(rep, obj);
            handle = rscTableCreateOwn(handleTable4, rep);
          }
          return handle;
        }
        ,
      }), 4, 4, 1],
      ],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
    })
    ],
    hasResultPointer: true,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline23,
  },
  );
  let trampoline24 = _trampoline24.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 24,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline24.manuallyAsync,
    paramLiftFns: [],
    resultLowerFns: [
    _lowerFlatOption({
      caseMetas: [
      [ 'none', null, 0, 0, 0 ],
      [ 'some', _lowerFlatOwn({
        componentIdx: 0,
        lowerFn: 
        function lowerImportedOwnedHost_TerminalOutput(obj) {
          if (!(obj instanceof TerminalOutput)) {
            throw new TypeError('Resource error: Not a valid \"TerminalOutput\" resource.');
          }
          let handle = obj[symbolRscHandle];
          if (!handle) {
            const rep = obj[symbolRscRep] || ++captureCnt5;
            captureTable5.set(rep, obj);
            handle = rscTableCreateOwn(handleTable5, rep);
          }
          return handle;
        }
        ,
      }), 4, 4, 1],
      ],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
    })
    ],
    hasResultPointer: true,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline24,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 24,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline24.manuallyAsync,
    paramLiftFns: [],
    resultLowerFns: [
    _lowerFlatOption({
      caseMetas: [
      [ 'none', null, 0, 0, 0 ],
      [ 'some', _lowerFlatOwn({
        componentIdx: 0,
        lowerFn: 
        function lowerImportedOwnedHost_TerminalOutput(obj) {
          if (!(obj instanceof TerminalOutput)) {
            throw new TypeError('Resource error: Not a valid \"TerminalOutput\" resource.');
          }
          let handle = obj[symbolRscHandle];
          if (!handle) {
            const rep = obj[symbolRscRep] || ++captureCnt5;
            captureTable5.set(rep, obj);
            handle = rscTableCreateOwn(handleTable5, rep);
          }
          return handle;
        }
        ,
      }), 4, 4, 1],
      ],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
    })
    ],
    hasResultPointer: true,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline24,
  },
  );
  let trampoline25 = _trampoline25.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 25,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline25.manuallyAsync,
    paramLiftFns: [],
    resultLowerFns: [
    _lowerFlatOption({
      caseMetas: [
      [ 'none', null, 0, 0, 0 ],
      [ 'some', _lowerFlatOwn({
        componentIdx: 0,
        lowerFn: 
        function lowerImportedOwnedHost_TerminalOutput(obj) {
          if (!(obj instanceof TerminalOutput)) {
            throw new TypeError('Resource error: Not a valid \"TerminalOutput\" resource.');
          }
          let handle = obj[symbolRscHandle];
          if (!handle) {
            const rep = obj[symbolRscRep] || ++captureCnt5;
            captureTable5.set(rep, obj);
            handle = rscTableCreateOwn(handleTable5, rep);
          }
          return handle;
        }
        ,
      }), 4, 4, 1],
      ],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
    })
    ],
    hasResultPointer: true,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline25,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 25,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline25.manuallyAsync,
    paramLiftFns: [],
    resultLowerFns: [
    _lowerFlatOption({
      caseMetas: [
      [ 'none', null, 0, 0, 0 ],
      [ 'some', _lowerFlatOwn({
        componentIdx: 0,
        lowerFn: 
        function lowerImportedOwnedHost_TerminalOutput(obj) {
          if (!(obj instanceof TerminalOutput)) {
            throw new TypeError('Resource error: Not a valid \"TerminalOutput\" resource.');
          }
          let handle = obj[symbolRscHandle];
          if (!handle) {
            const rep = obj[symbolRscRep] || ++captureCnt5;
            captureTable5.set(rep, obj);
            handle = rscTableCreateOwn(handleTable5, rep);
          }
          return handle;
        }
        ,
      }), 4, 4, 1],
      ],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
    })
    ],
    hasResultPointer: true,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline25,
  },
  );
  Promise.all([module0, module1, module2]).catch(() => {});
  ({ exports: exports0 } = yield instantiateCore(yield module1));
  ({ exports: exports1 } = yield instantiateCore(yield module0, {
    'host:interfaces/http-with-placeholders@2.1.0': {
      call: exports0['4'],
    },
    'host:interfaces/http@2.1.0': {
      call: exports0['5'],
    },
    'host:interfaces/kv-store@2.1.0': {
      get: exports0['3'],
      put: exports0['2'],
    },
    'host:interfaces/logging@2.1.0': {
      info: exports0['0'],
    },
    'host:tenant/tenant-context@1.0.0': {
      'cluster-timestamp-secs': trampoline0,
      'tenant-did': exports0['1'],
    },
    'wasi:cli/environment@0.2.0': {
      'get-environment': exports0['9'],
    },
    'wasi:cli/exit@0.2.0': {
      exit: trampoline7,
    },
    'wasi:cli/stderr@0.2.0': {
      'get-stderr': trampoline12,
    },
    'wasi:cli/stdin@0.2.0': {
      'get-stdin': trampoline10,
    },
    'wasi:cli/stdout@0.2.0': {
      'get-stdout': trampoline11,
    },
    'wasi:cli/terminal-input@0.2.0': {
      '[resource-drop]terminal-input': _guardMayLeave(0, trampoline5),
    },
    'wasi:cli/terminal-output@0.2.0': {
      '[resource-drop]terminal-output': _guardMayLeave(0, trampoline6),
    },
    'wasi:cli/terminal-stderr@0.2.0': {
      'get-terminal-stderr': exports0['12'],
    },
    'wasi:cli/terminal-stdin@0.2.0': {
      'get-terminal-stdin': exports0['10'],
    },
    'wasi:cli/terminal-stdout@0.2.0': {
      'get-terminal-stdout': exports0['11'],
    },
    'wasi:io/error@0.2.0': {
      '[resource-drop]error': _guardMayLeave(0, trampoline1),
    },
    'wasi:io/poll@0.2.0': {
      '[method]pollable.block': trampoline8,
      '[resource-drop]pollable': _guardMayLeave(0, trampoline2),
    },
    'wasi:io/streams@0.2.0': {
      '[method]output-stream.blocking-flush': exports0['8'],
      '[method]output-stream.check-write': exports0['6'],
      '[method]output-stream.subscribe': trampoline9,
      '[method]output-stream.write': exports0['7'],
      '[resource-drop]input-stream': _guardMayLeave(0, trampoline3),
      '[resource-drop]output-stream': _guardMayLeave(0, trampoline4),
    },
  }));
  memory0 = exports1.memory;
  realloc0 = exports1.cabi_realloc;
  
  try {
    realloc0Async = WebAssembly.promising(exports1.cabi_realloc);
  } catch(err) {
    realloc0Async = exports1.cabi_realloc;
  }
  
  ({ exports: exports2 } = yield instantiateCore(yield module2, {
    '': {
      $imports: exports0.$imports,
      '0': trampoline13,
      '1': trampoline14,
      '10': trampoline23,
      '11': trampoline24,
      '12': trampoline25,
      '2': trampoline15,
      '3': trampoline16,
      '4': trampoline17,
      '5': trampoline18,
      '6': trampoline19,
      '7': trampoline20,
      '8': trampoline21,
      '9': trampoline22,
    },
  }));
  postReturn0 = exports1['cabi_post_z:gate-contract/contracts@0.1.0#dispatch-action'];
  
  try {
    postReturn0Async = WebAssembly.promising(exports1['cabi_post_z:gate-contract/contracts@0.1.0#dispatch-action']);
  } catch(err) {
    postReturn0Async = exports1['cabi_post_z:gate-contract/contracts@0.1.0#dispatch-action'];
  }
  
  contracts010Evaluate = exports1['z:gate-contract/contracts@0.1.0#evaluate'];
  contracts010Spend = exports1['z:gate-contract/contracts@0.1.0#spend'];
  contracts010DispatchAction = exports1['z:gate-contract/contracts@0.1.0#dispatch-action'];
  contracts010ExecuteAction = exports1['z:gate-contract/contracts@0.1.0#execute-action'];
  const contracts010 = {
    dispatchAction: dispatchAction,
    evaluate: evaluate,
    executeAction: executeAction,
    spend: spend,
    
  };
  
  return { contracts: contracts010, 'z:gate-contract/contracts@0.1.0': contracts010,  };
})();
let promise, resolve, reject;
function runNext (value) {
  try {
    let done;
    do {
      ({ value, done } = gen.next(value));
    } while (!(value instanceof Promise) && !done);
    if (done) {
      if (resolve) return resolve(value);
      else return value;
    }
    if (!promise) promise = new Promise((_resolve, _reject) => (resolve = _resolve, reject = _reject));
    value.then(nextVal => done ? resolve() : runNext(nextVal), reject);
  }
  catch (e) {
    if (reject) reject(e);
    else throw e;
  }
}
const maybeSyncReturn = runNext(null);
return promise || maybeSyncReturn;
};

export const _util = {
  
}

