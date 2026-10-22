const mockValues = new Map();
const mockStartForegroundService = jest.fn(async () => [true, 'running']);
const mockArmServiceRecovery = jest.fn();

jest.mock('react-native', () => ({
  NativeModules: {NativeBridgeModule: {armServiceRecovery: mockArmServiceRecovery}},
}));
jest.mock('../AsyncStorageManagement', () => ({
  getDataFromAsyncStorage: jest.fn(async key => mockValues.get(key) ?? null),
  setDataInAsyncStorage: jest.fn(async (key, value) => mockValues.set(key, value)),
  clearAsyncStorage: jest.fn(),
}));
jest.mock('../StartForegroundService', () => mockStartForegroundService);

const HeadlessTask = require('../HeadlessTask');

beforeEach(() => {
  mockValues.clear();
  mockStartForegroundService.mockClear();
  mockArmServiceRecovery.mockClear();
});

test('recovers a desired foreground service after process death', async () => {
  mockValues.set('wsIsRunning', 'true');

  await HeadlessTask({event: 'SERVICE_RECOVERY'});

  expect(mockArmServiceRecovery).toHaveBeenCalledTimes(1);
  expect(mockStartForegroundService).toHaveBeenCalledTimes(1);
  expect(mockValues.get('wsForegroundServiceTerminated')).toBe('false');
});

test('does not resurrect a service the user stopped', async () => {
  mockValues.set('wsIsRunning', 'false');

  await HeadlessTask({event: 'SERVICE_RECOVERY'});

  expect(mockArmServiceRecovery).not.toHaveBeenCalled();
  expect(mockStartForegroundService).not.toHaveBeenCalled();
});
