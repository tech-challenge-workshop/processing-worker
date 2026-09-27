import { brokerSuiteMode } from './broker-guard';

// ROB-08: the broker suite may skip on a developer machine, but never in CI,
// or a missing broker would turn the suite green by skipping it.
describe('brokerSuiteMode', () => {
  it('fails the suite when CI is set and RABBITMQ_TEST_URL is not', () => {
    expect(brokerSuiteMode({ CI: 'true' })).toBe('fail');
  });

  it('skips the suite when neither CI nor RABBITMQ_TEST_URL is set', () => {
    expect(brokerSuiteMode({})).toBe('skip');
  });

  it('runs the suite when RABBITMQ_TEST_URL is set', () => {
    expect(brokerSuiteMode({ RABBITMQ_TEST_URL: 'amqp://x' })).toBe('run');
  });

  it('treats CI=false as unset and skips the suite', () => {
    expect(brokerSuiteMode({ CI: 'false' })).toBe('skip');
  });
});
