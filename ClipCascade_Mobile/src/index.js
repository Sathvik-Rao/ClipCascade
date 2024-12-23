/**
 * ClipCascade - A seamless clipboard syncing utility
 * Repository: https://github.com/Sathvik-Rao/ClipCascade
 *
 * Author: Sathvik Rao Poladi
 * License: GPL-3.0
 *
 * This file is the entry point for the React Native application.
 *
 */

import {AppRegistry} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

AppRegistry.registerComponent(appName, () => App);
AppRegistry.registerHeadlessTask('Restart', () => require('./HeadlessTask'));
