// M7 dogfood — fires after the render walk + any declarative hooks.
// Reads the freshly-rendered package.json through the sandboxed FS
// facade, optionally splices in a "repository" field based on the
// hook-prompt answer, and writes back through the facade. Demonstrates:
//
//   - hook-defined prompts (answer at answers.hooks.repository.*)
//   - project.read + project.write round-trip
//   - log.{info,warn} surfacing through the host sink
//   - conditional logic on user input

var coord = (answers.hooks.repository.github_coord || '').trim();

if (coord.length === 0) {
  log.info('node-ts-hooked: no repository coordinate, leaving package.json untouched');
} else if (!/^[\w.-]+\/[\w.-]+$/.test(coord)) {
  log.warn(
    'node-ts-hooked: skipping repository field — "' +
      coord +
      '" does not look like owner/name',
  );
} else {
  var pkg = JSON.parse(project.read('package.json'));
  pkg.repository = 'github:' + coord;
  project.write('package.json', JSON.stringify(pkg, null, 2) + '\n');
  log.info('node-ts-hooked: set package.json repository = github:' + coord);
}
