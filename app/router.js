'use strict';

module.exports = app => {
  const { router, controller } = app;
  router.get('/login', controller.auth.show);
  router.post('/login', controller.auth.login);
  router.post('/logout', controller.auth.logout);
  router.post('/current-project', controller.project.switchProject);
  router.get('/', controller.home.index);
  router.get('/health', controller.home.health);
  router.get('/dedupe', controller.dedupe.index);
  router.get('/project-overview', controller.project.overview);
  router.get('/standards', controller.standardCatalog.index);
  router.post('/standards', controller.standardCatalog.createStandard);
  router.post('/standards/:standardId/versions', controller.standardCatalog.createVersion);
  router.get('/standards/versions/:versionId', controller.standardCatalog.version);
  router.post('/standards/versions/:versionId/publish', controller.standardCatalog.publishVersion);
  router.post('/standards/versions/:versionId/chapters', controller.standardCatalog.createChapter);
  router.post('/standards/chapters/:chapterId/items', controller.standardCatalog.createItem);
  router.post('/standards/chapters/:chapterId/import', controller.standardCatalog.importItems);
  router.get('/projects', controller.project.index);
  router.post('/projects', controller.project.create);
  router.get('/projects/:projectId/manage', controller.project.manage);
  router.get('/projects/:projectId', controller.project.detail);
  router.post('/projects/:projectId/answers/:standardItemId', controller.project.saveAnswer);
  router.get('/api/dedupe/candidates', controller.dedupe.candidates);
  router.post('/api/dedupe/ai-review', controller.dedupe.aiReview);
  router.post('/api/dedupe/reviews', controller.dedupe.review);
};
