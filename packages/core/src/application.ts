// Copyright IBM Corp. 2017,2020. All Rights Reserved.
// Node module: @loopback/core
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

import {
  Binding,
  BindingScope,
  Constructor,
  Context,
  createBindingFromClass,
  JSONObject,
  Provider,
} from '@loopback/context';
import assert from 'assert';
import debugFactory from 'debug';
import pEvent from 'p-event';
import {Component, mountComponent} from './component';
import {CoreBindings, CoreTags} from './keys';
import {
  asLifeCycleObserver,
  isLifeCycleObserverClass,
  LifeCycleObserver,
} from './lifecycle';
import {LifeCycleObserverRegistry} from './lifecycle-registry';
import {Server} from './server';
import {createServiceBinding, ServiceOptions} from './service';
const debug = debugFactory('loopback:core:application');
const debugShutdown = debugFactory('loopback:core:application:shutdown');
const debugWarning = debugFactory('loopback:core:application:warning');

/**
 * A helper function to build constructor args for `Context`
 * @param configOrParent - Application config or parent context
 * @param parent - Parent context if the first arg is application config
 */
function buildConstructorArgs(
  configOrParent?: ApplicationConfig | Context,
  parent?: Context,
) {
  let name: string | undefined;
  let parentCtx: Context | undefined;

  if (configOrParent instanceof Context) {
    parentCtx = configOrParent;
    name = undefined;
  } else {
    parentCtx = parent;
    name = configOrParent?.name;
  }
  return [parentCtx, name];
}

/**
 * Application is the container for various types of artifacts, such as
 * components, servers, controllers, repositories, datasources, connectors,
 * and models.
 */
export class Application extends Context implements LifeCycleObserver {
  public readonly options: ApplicationConfig;

  /**
   * A flag to indicate that the application is being shut down
   */
  private _isShuttingDown = false;
  private _shutdownOptions: ShutdownOptions;
  private _signalListener: (signal: string) => Promise<void>;

  /**
   * State of the application
   */
  private _state = 'created';

  /**
   * Get the state of the application. The initial state is `created` and it can
   * transition as follows by `start` and `stop`:
   *
   * 1. start
   *   - !started -> starting -> started
   *   - started -> started (no-op)
   * 2. stop
   *   - started -> stopping -> stopped
   *   - !started -> stopped (no-op)
   *
   * Two types of states are expected:
   * - stable, such as `started` and `stopped`
   * - in process, such as `booting` and `starting`
   *
   * Operations such as `start` and `stop` can only be called at a stable state.
   * The logic should immediately set the state to a new one indicating work in
   * process, such as `starting` and `stopping`.
   */
  public get state() {
    return this._state;
  }

  /**
   * Create an application with the given parent context
   * @param parent - Parent context
   */
  constructor(parent: Context);
  /**
   * Create an application with the given configuration and parent context
   * @param config - Application configuration
   * @param parent - Parent context
   */
  constructor(config?: ApplicationConfig, parent?: Context);

  constructor(configOrParent?: ApplicationConfig | Context, parent?: Context) {
    // super() has to be first statement for a constructor
    super(...buildConstructorArgs(configOrParent, parent));

    this.options =
      configOrParent instanceof Context ? {} : configOrParent ?? {};

    // Configure debug
    this._debug = debug;

    // Bind the life cycle observer registry
    this.bind(CoreBindings.LIFE_CYCLE_OBSERVER_REGISTRY)
      .toClass(LifeCycleObserverRegistry)
      .inScope(BindingScope.SINGLETON);
    // Bind to self to allow injection of application context in other modules.
    this.bind(CoreBindings.APPLICATION_INSTANCE).to(this);
    // Make options available to other modules as well.
    this.bind(CoreBindings.APPLICATION_CONFIG).to(this.options);

    this._shutdownOptions = {signals: ['SIGTERM'], ...this.options.shutdown};
  }

  /**
   * Register a controller class with this application.
   *
   * @param controllerCtor - The controller class
   * (constructor function).
   * @param name - Optional controller name, default to the class name
   * @returns The newly created binding, you can use the reference to
   * further modify the binding, e.g. lock the value to prevent further
   * modifications.
   *
   * @example
   * ```ts
   * class MyController {
   * }
   * app.controller(MyController).lock();
   * ```
   */
  controller(controllerCtor: ControllerClass, name?: string): Binding {
    this.debug('Adding controller %s', name ?? controllerCtor.name);
    const binding = createBindingFromClass(controllerCtor, {
      name,
      namespace: CoreBindings.CONTROLLERS,
      type: CoreTags.CONTROLLER,
      defaultScope: BindingScope.TRANSIENT,
    });
    this.add(binding);
    return binding;
  }

  /**
   * Bind a Server constructor to the Application's master context.
   * Each server constructor added in this way must provide a unique prefix
   * to prevent binding overlap.
   *
   * @example
   * ```ts
   * app.server(RestServer);
   * // This server constructor will be bound under "servers.RestServer".
   * app.server(RestServer, "v1API");
   * // This server instance will be bound under "servers.v1API".
   * ```
   *
   * @param server - The server constructor.
   * @param name - Optional override for key name.
   * @returns Binding for the server class
   *
   */
  public server<T extends Server>(
    ctor: Constructor<T>,
    name?: string,
  ): Binding<T> {
    this.debug('Adding server %s', name ?? ctor.name);
    const binding = createBindingFromClass(ctor, {
      name,
      namespace: CoreBindings.SERVERS,
      type: CoreTags.SERVER,
      defaultScope: BindingScope.SINGLETON,
    }).apply(asLifeCycleObserver);
    this.add(binding);
    return binding;
  }

  /**
   * Bind an array of Server constructors to the Application's master
   * context.
   * Each server added in this way will automatically be named based on the
   * class constructor name with the "servers." prefix.
   *
   * @remarks
   * If you wish to control the binding keys for particular server instances,
   * use the app.server function instead.
   * ```ts
   * app.servers([
   *  RestServer,
   *  GRPCServer,
   * ]);
   * // Creates a binding for "servers.RestServer" and a binding for
   * // "servers.GRPCServer";
   * ```
   *
   * @param ctors - An array of Server constructors.
   * @returns An array of bindings for the registered server classes
   *
   */
  public servers<T extends Server>(ctors: Constructor<T>[]): Binding[] {
    return ctors.map(ctor => this.server(ctor));
  }

  /**
   * Retrieve the singleton instance for a bound server.
   *
   * @typeParam T - Server type
   * @param ctor - The constructor that was used to make the
   * binding.
   * @returns A Promise of server instance
   *
   */
  public async getServer<T extends Server>(
    target: Constructor<T> | string,
  ): Promise<T> {
    let key: string;
    // instanceof check not reliable for string.
    if (typeof target === 'string') {
      key = `${CoreBindings.SERVERS}.${target}`;
    } else {
      const ctor = target as Constructor<T>;
      key = `${CoreBindings.SERVERS}.${ctor.name}`;
    }
    return this.get<T>(key);
  }

  /**
   * Assert there is no other operation is in progress, i.e., the state is not
   * `*ing`, such as `starting` or `stopping`.
   *
   * @param op - The operation name, such as 'boot', 'start', or 'stop'
   */
  protected assertNotInProcess(op: string) {
    assert(
      !this._state.endsWith('ing'),
      `Cannot ${op} the application as it is ${this._state}.`,
    );
  }

  /**
   * Assert current state of the application to be one of the expected values
   * @param op - The operation name, such as 'boot', 'start', or 'stop'
   * @param states - Valid states
   */
  protected assertInStates(op: string, ...states: string[]) {
    assert(
      states.includes(this._state),
      `Cannot ${op} the application as it is ${this._state}. Valid states are ${states}.`,
    );
  }

  /**
   * Transition the application to a new state and emit an event
   * @param state - The new state
   */
  protected setState(state: string) {
    const oldState = this._state;
    this._state = state;
    if (oldState !== state) {
      this.emit('stateChanged', {from: oldState, to: this._state});
      this.emit(state);
    }
  }

  protected async awaitState(state: string) {
    await pEvent(this, state);
  }

  /**
   * Start the application, and all of its registered observers. The application
   * state is checked to ensure the integrity of `start`.
   *
   * If the application is already started, no operation is performed.
   */
  public async start(): Promise<void> {
    if (this._state === 'starting') return this.awaitState('started');
    this.assertNotInProcess('start');
    // No-op if it's started
    if (this._state === 'started') return;
    this.setState('starting');
    this.setupShutdown();

    const registry = await this.getLifeCycleObserverRegistry();
    await registry.start();
    this.setState('started');
  }

  /**
   * Stop the application instance and all of its registered observers. The
   * application state is checked to ensure the integrity of `stop`.
   *
   * If the application is already stopped or not started, no operation is
   * performed.
   */
  public async stop(): Promise<void> {
    if (this._state === 'stopping') return this.awaitState('stopped');
    this.assertNotInProcess('stop');
    // No-op if it's created or stopped
    if (this._state !== 'started') return;
    this.setState('stopping');
    if (!this._isShuttingDown) {
      // Explicit stop is called, let's remove signal listeners to avoid
      // memory leak and max listener warning
      this.removeSignalListener();
    }
    const registry = await this.getLifeCycleObserverRegistry();
    await registry.stop();
    this.setState('stopped');
  }

  private async getLifeCycleObserverRegistry() {
    return this.get(CoreBindings.LIFE_CYCLE_OBSERVER_REGISTRY);
  }

  /**
   * Add a component to this application and register extensions such as
   * controllers, providers, and servers from the component.
   *
   * @param componentCtor - The component class to add.
   * @param name - Optional component name, default to the class name
   *
   * @example
   * ```ts
   *
   * export class ProductComponent {
   *   controllers = [ProductController];
   *   repositories = [ProductRepo, UserRepo];
   *   providers = {
   *     [AUTHENTICATION_STRATEGY]: AuthStrategy,
   *     [AUTHORIZATION_ROLE]: Role,
   *   };
   * };
   *
   * app.component(ProductComponent);
   * ```
   */
  public component(componentCtor: Constructor<Component>, name?: string) {
    this.debug('Adding component: %s', name ?? componentCtor.name);
    const binding = createBindingFromClass(componentCtor, {
      name,
      namespace: CoreBindings.COMPONENTS,
      type: CoreTags.COMPONENT,
      defaultScope: BindingScope.SINGLETON,
    });
    if (isLifeCycleObserverClass(componentCtor)) {
      binding.apply(asLifeCycleObserver);
    }
    this.add(binding);
    // Assuming components can be synchronously instantiated
    const instance = this.getSync<Component>(binding.key);
    mountComponent(this, instance);
    return binding;
  }

  /**
   * Set application metadata. `@loopback/boot` calls this method to populate
   * the metadata from `package.json`.
   *
   * @param metadata - Application metadata
   */
  public setMetadata(metadata: ApplicationMetadata) {
    this.bind(CoreBindings.APPLICATION_METADATA).to(metadata);
  }

  /**
   * Register a life cycle observer class
   * @param ctor - A class implements LifeCycleObserver
   * @param name - Optional name for the life cycle observer
   */
  public lifeCycleObserver<T extends LifeCycleObserver>(
    ctor: Constructor<T>,
    name?: string,
  ): Binding<T> {
    this.debug('Adding life cycle observer %s', name ?? ctor.name);
    const binding = createBindingFromClass(ctor, {
      name,
      namespace: CoreBindings.LIFE_CYCLE_OBSERVERS,
      type: CoreTags.LIFE_CYCLE_OBSERVER,
      defaultScope: BindingScope.SINGLETON,
    }).apply(asLifeCycleObserver);
    this.add(binding);
    return binding;
  }

  /**
   * Add a service to this application.
   *
   * @param cls - The service or provider class
   *
   * @example
   *
   * ```ts
   * // Define a class to be bound via ctx.toClass()
   * @bind({scope: BindingScope.SINGLETON})
   * export class LogService {
   *   log(msg: string) {
   *     console.log(msg);
   *   }
   * }
   *
   * // Define a class to be bound via ctx.toProvider()
   * import {v4 as uuidv4} from 'uuid';
   * export class UuidProvider implements Provider<string> {
   *   value() {
   *     return uuidv4();
   *   }
   * }
   *
   * // Register the local services
   * app.service(LogService);
   * app.service(UuidProvider, 'uuid');
   *
   * export class MyController {
   *   constructor(
   *     @inject('services.uuid') private uuid: string,
   *     @inject('services.LogService') private log: LogService,
   *   ) {
   *   }
   *
   *   greet(name: string) {
   *     this.log(`Greet request ${this.uuid} received: ${name}`);
   *     return `${this.uuid}: ${name}`;
   *   }
   * }
   * ```
   */
  public service<S>(
    cls: Constructor<S> | Constructor<Provider<S>>,
    name?: string | ServiceOptions,
  ): Binding<S> {
    const options = typeof name === 'string' ? {name} : name;
    const binding = createServiceBinding(cls, options);
    this.add(binding);
    return binding;
  }

  /**
   * Set up signals that are captured to shutdown the application
   */
  protected setupShutdown() {
    if (this._signalListener != null) {
      this.registerSignalListener();
      return this._signalListener;
    }
    const gracePeriod = this._shutdownOptions.gracePeriod;
    this._signalListener = async (signal: string) => {
      const kill = () => {
        this.removeSignalListener();
        process.kill(process.pid, signal);
      };
      debugShutdown(
        '[%s] Signal %s received for process %d',
        this.name,
        signal,
        process.pid,
      );
      if (!this._isShuttingDown) {
        this._isShuttingDown = true;
        let timer;
        if (typeof gracePeriod === 'number' && !isNaN(gracePeriod)) {
          timer = setTimeout(kill, gracePeriod);
        }
        try {
          await this.stop();
        } finally {
          if (timer != null) clearTimeout(timer);
          kill();
        }
      }
    };
    this.registerSignalListener();
    return this._signalListener;
  }

  private registerSignalListener() {
    const {signals = []} = this._shutdownOptions;
    debugShutdown(
      '[%s] Registering signal listeners on the process %d',
      this.name,
      process.pid,
      signals,
    );
    signals.forEach(sig => {
      if (process.getMaxListeners() <= process.listenerCount(sig)) {
        if (debugWarning.enabled) {
          debugWarning(
            '[%s] %d %s listeners are added to process %d',
            this.name,
            process.listenerCount(sig),
            sig,
            process.pid,
            new Error('MaxListenersExceededWarning'),
          );
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      process.on(sig, this._signalListener);
    });
  }

  private removeSignalListener() {
    if (this._signalListener == null) return;
    const {signals = []} = this._shutdownOptions;
    debugShutdown(
      '[%s] Removing signal listeners on the process %d',
      this.name,
      process.pid,
      signals,
    );
    signals.forEach(sig =>
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      process.removeListener(sig, this._signalListener),
    );
  }
}

/**
 * Options to set up application shutdown
 */
export type ShutdownOptions = {
  /**
   * An array of signals to be trapped for graceful shutdown
   */
  signals?: NodeJS.Signals[];
  /**
   * Period in milliseconds to wait for the grace shutdown to finish before
   * exiting the process
   */
  gracePeriod?: number;
};

/**
 * Configuration for application
 */
export interface ApplicationConfig {
  /**
   * Name of the application context
   */
  name?: string;
  /**
   * Configuration for signals that shut down the application
   */
  shutdown?: ShutdownOptions;

  /**
   * Other properties
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [prop: string]: any;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ControllerClass = Constructor<any>;

/**
 * Type description for `package.json`
 */
export interface ApplicationMetadata extends JSONObject {
  name: string;
  version: string;
  description: string;
}
