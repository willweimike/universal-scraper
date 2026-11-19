const base = {
  import: ['features/support/**/*.ts', 'features/steps/**/*.ts'],
  paths: ['features/**/*.feature'],
  format: ['progress'],
  publishQuiet: true,
};

module.exports = {
  // Everything except scenarios that only make sense in the bare container (no curl/wget on PATH).
  default: { ...base, tags: 'not @container' },
  // Dockerfile.accept: the acceptance suite, including the container-only scenarios.
  container: { ...base, tags: '@acceptance' },
};
