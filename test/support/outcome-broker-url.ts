// Imported for its side effect, ahead of the app module: the outcome
// publishers read RABBITMQ_URL when the messaging module is loaded, so a
// suite that publishes to the test broker points them there first.
if (process.env.RABBITMQ_TEST_URL) {
  process.env.RABBITMQ_URL = process.env.RABBITMQ_TEST_URL;
}
