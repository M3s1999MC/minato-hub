'use strict';

class HubError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HubError';
    this.status = status;
  }
}

module.exports = { HubError };
