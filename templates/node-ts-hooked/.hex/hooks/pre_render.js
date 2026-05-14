// M7 dogfood — fires after prompts, before the render walk. Just
// observes the context so the integration test can assert that the
// pre_render lifecycle ran (and saw the right answers).
log.info(
  'node-ts-hooked: pre_render for ' +
    answers.project_name +
    ' (recipe=' +
    (recipe === null ? 'standalone' : recipe.name) +
    ')',
);
