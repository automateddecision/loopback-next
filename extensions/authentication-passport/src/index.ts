// Copyright IBM Corp. 2019. All Rights Reserved.
// Node module: @loopback/authentication-passport
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT
import {
  startApp,
  stopApp,
} from './__tests__/acceptance/fixtures/mock-oauth2-social-app';

export * from './strategy-adapter';

export namespace MockTestOauth2SocialApp {
  export const startMock = startApp;
  export const stopMock = stopApp;
}
