'use strict';

module.exports = app => {
  const { router, controller } = app;
  router.get('/', controller.home.index);
  router.get('/health', controller.home.health);
  router.get('/dedupe', controller.dedupe.index);
  router.get('/api/dedupe/candidates', controller.dedupe.candidates);
  router.post('/api/dedupe/ai-review', controller.dedupe.aiReview);
  router.post('/api/dedupe/reviews', controller.dedupe.review);
};
