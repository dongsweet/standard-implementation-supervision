'use strict';

const { Pool } = require('pg');

module.exports = {
  get db() {
    if (!this._dbPool) {
      this._dbPool = new Pool(this.config.database.connectionString ? {
        connectionString: this.config.database.connectionString,
        max: this.config.database.max,
      } : this.config.database);
      this.beforeClose(async () => this._dbPool.end());
    }
    return this._dbPool;
  },
};
