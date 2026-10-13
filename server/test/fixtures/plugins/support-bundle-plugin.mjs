// A plugin that implements `support-bundle` and registers nothing (core collects the bundle and
// owns the command), so a test of the test bundle can run `main.js support-bundle` licensed.
export default {
  name: 'support-bundle-fixture',
  apiVersion: 1,
  features: ['support-bundle'],
  register() {},
};
