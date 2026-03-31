import path from 'path';

class ProgressReporter {
  constructor() {
    this.total = 0;
    this.done = 0;
    this.passed = 0;
    this.failed = 0;
  }

  onBegin(config, suite) {
    this.total = suite.allTests().length;
    process.stdout.write(`Running ${this.total} tests...\n`);
  }

  onTestEnd(test, result) {
    this.done++;
    const pct = Math.round(this.done / this.total * 100);
    const specfile = path.basename(test.location.file, path.extname(test.location.file));
    const duration = (result.duration / 1000).toFixed(1) + 's';
    const icon = result.status === 'passed' ? '✓' : '✗';

    if (result.status === 'passed') {
      this.passed++;
    } else {
      this.failed++;
    }

    process.stdout.write(
      `[${this.done}/${this.total}] ${pct}%  ${specfile} — ${test.title} ${icon}  (${duration})\n`
    );

    if (result.status !== 'passed') {
      const errorMessage = result.error?.message ?? result.errors?.[0]?.message ?? '';
      const firstLine = errorMessage.split('\n')[0];
      if (firstLine) {
        process.stdout.write(`  → ${firstLine}\n`);
      }
    }
  }

  onEnd(result) {
    const d = result.duration;
    const mins = Math.floor(d / 60000);
    const secs = Math.floor((d % 60000) / 1000);
    process.stdout.write(
      `\nPassed: ${this.passed}  Failed: ${this.failed}  Total: ${this.total}  Duration: ${mins}m ${secs}s\n`
    );
  }
}

export default ProgressReporter;
