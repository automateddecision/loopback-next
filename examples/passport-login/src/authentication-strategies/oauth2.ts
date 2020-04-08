// Copyright IBM Corp. 2019. All Rights Reserved.
// Node module: example-passport-oauth2-login
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

import {
  AuthenticationStrategy,
  UserIdentityService,
  asAuthStrategy,
  AuthenticationBindings,
} from '@loopback/authentication';
import {StrategyAdapter} from '@loopback/authentication-passport';
import {Profile} from 'passport';
import {Strategy, StrategyOptions} from 'passport-oauth2';
import {Request, RedirectRoute} from '@loopback/rest';
import {UserProfile, securityId} from '@loopback/security';
import {User} from '../models';
import {UserServiceBindings} from '../services';
import {inject, bind, extensions, Getter} from '@loopback/core';

export namespace PassportAuthenticationBindings {
  export const OAUTH2_STRATEGY = 'passport.authentication.oauth2.strategy';
}

type profileFunction = (
  accessToken: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  done: (err?: Error | null, profile?: any) => void,
) => void;

@bind(asAuthStrategy)
export class Oauth2AuthStrategy implements AuthenticationStrategy {
  name = 'oauth2';
  passportstrategy: Strategy;
  protected strategy: StrategyAdapter<User>;

  /**
   * create an oauth2 strategy
   */
  constructor(
    /**
     * enable extensions for provider specific oauth2 implementations
     * reroute to the specific extension based on given provider name
     */
    @extensions(PassportAuthenticationBindings.OAUTH2_STRATEGY)
    private getStrategies: Getter<Oauth2AuthStrategy[]>,
    @inject(UserServiceBindings.PASSPORT_USER_IDENTITY_SERVICE)
    public userService: UserIdentityService<Profile, User>,
    @inject('customOAuth2Options')
    public oauth2Options: StrategyOptions,
    @inject('authentication.oauth2.profile.function', {optional: true})
    public profileFunction: profileFunction,
  ) {
    /**
     * Create a oauth2 strategy instance for a custom provider implementation
     */
    this.passportstrategy = new Strategy(oauth2Options, this.verify.bind(this));
    if (profileFunction) {
      this.passportstrategy.userProfile = profileFunction;
    }
    this.strategy = new StrategyAdapter(
      this.passportstrategy,
      this.name,
      this.mapProfile.bind(this),
    );
  }

  /**
   * verify function for the oauth2 strategy
   *
   * @param accessToken
   * @param refreshToken
   * @param profile
   * @param done
   */
  verify(
    accessToken: string,
    refreshToken: string,
    profile: Profile,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    done: (error: any, user?: any, info?: any) => void,
  ) {
    // look up a linked user for the profile
    this.userService
      .findOrCreateUser(profile)
      .then((user: User) => {
        done(null, user);
      })
      .catch((err: Error) => {
        done(err);
      });
  }

  /**
   * authenticate a request
   * @param request
   */
  async authenticate(request: Request): Promise<UserProfile | RedirectRoute> {
    if (
      request.query['oauth2-provider-name'] &&
      request.query['oauth2-provider-name'] !== 'oauth2'
    ) {
      /**
       * if provider name is given then reroute to the provider extension
       */
      const providerName = request.query['oauth2-provider-name'];
      const strategies: Oauth2AuthStrategy[] = await this.getStrategies();
      const strategy = strategies.find(
        (s: Oauth2AuthStrategy) => s.name === 'oauth2-' + providerName,
      );
      if (!strategy) throw new Error('provider not found');
      return strategy.authenticate(request);
    } else {
      /**
       * provider not given, use passport-oauth2 for custom provider implementation
       */
      return this.strategy.authenticate(request);
    }
  }

  /**
   * map passport profile to user profile
   * @param user
   */
  mapProfile(user: User): UserProfile {
    const userProfile: UserProfile = {
      [securityId]: '' + user.id,
      profile: {
        ...user,
      },
    };
    return userProfile;
  }
}
