class JobQueue {
  constructor({ concurrency = 1, name = 'queue' } = {}) {
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.name = name;
    this.running = 0;
    this.pending = [];
  }

  get size() {
    return this.pending.length;
  }

  add(job) {
    return new Promise((resolve, reject) => {
      this.pending.push({ job, resolve, reject });
      this.next();
    });
  }

  next() {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const item = this.pending.shift();
      this.running += 1;

      Promise.resolve()
        .then(item.job)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.running -= 1;
          this.next();
        });
    }
  }
}

module.exports = { JobQueue };
