import { Component } from 'react';

export default class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, copied: false, copyFailed: false };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error, copied: false, copyFailed: false };
  }

  componentDidCatch(error, info) {
    // Keep diagnostics in the console; never send error details to the server.
    console.error('[AshkanBoard] UI rendering failed', error, info?.componentStack || '');
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null, copied: false, copyFailed: false });
  };

  handleCopyReport = async () => {
    const isPersian = typeof document !== 'undefined' && document.documentElement.lang.toLowerCase().startsWith('fa');
    const report = [
      'AshkanBoard UI Error Report',
      `Time: ${new Date().toISOString()}`,
      `URL: ${window.location.href}`,
      `User agent: ${navigator.userAgent}`,
      `Error: ${this.state.error?.name || 'Error'}: ${this.state.error?.message || 'Unknown error'}`,
      `Stack: ${this.state.error?.stack || 'Unavailable'}`,
    ].join('\n');

    try {
      await navigator.clipboard.writeText(report);
      this.setState({ copied: true, copyFailed: false });
    } catch {
      this.setState({ copied: false, copyFailed: true });
      // The report remains visible in the expandable details for manual copying.
    }
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    const isPersian = typeof document !== 'undefined' && document.documentElement.lang.toLowerCase().startsWith('fa');
    const errorDetails = `${this.state.error?.name || 'Error'}: ${this.state.error?.message || 'Unknown error'}\n\n${this.state.error?.stack || ''}`;

    return (
      <main className="app-error-screen" role="alert" aria-live="assertive" dir={isPersian ? 'rtl' : 'ltr'}>
        <section className="app-error-card">
          <div className="app-error-mark" aria-hidden="true">!</div>
          <p className="app-error-eyebrow">ASHKANBOARD</p>
          <h1>{isPersian ? 'بخشی از برنامه با خطا روبه‌رو شد' : 'Something went wrong'}</h1>
          <p>{isPersian
            ? 'برنامه متوقف نشده است. می‌توانید این بخش را دوباره بارگذاری کنید یا گزارش خطا را برای بررسی کپی کنید.'
            : 'The application is still available. Retry this view or copy the diagnostic report for troubleshooting.'}</p>
          <div className="app-error-actions">
            <button type="button" className="primary-button" onClick={this.handleRetry}>
              {isPersian ? 'تلاش دوباره' : 'Try again'}
            </button>
            <button type="button" className="secondary-button" onClick={() => window.location.reload()}>
              {isPersian ? 'تازه‌سازی صفحه' : 'Reload page'}
            </button>
            <button type="button" className="secondary-button" onClick={this.handleCopyReport}>
              {isPersian ? 'کپی گزارش خطا' : 'Copy error report'}
            </button>
          </div>
          <p className="app-error-copy-status" role="status" aria-live="polite">
            {this.state.copied ? (isPersian ? 'گزارش خطا کپی شد.' : 'Error report copied.') : ''}
            {this.state.copyFailed ? (isPersian ? 'کپی خودکار انجام نشد؛ جزئیات زیر را دستی کپی کنید.' : 'Clipboard access failed. Copy the details below manually.') : ''}
          </p>
          <details className="app-error-details">
            <summary>{isPersian ? 'نمایش جزئیات خطا' : 'Show error details'}</summary>
            <pre>{errorDetails}</pre>
          </details>
          <small>{isPersian ? 'گزارش فقط با اقدام شما کپی می‌شود و به سرور ارسال نمی‌شود.' : 'The report is copied only when requested and is not sent to a server.'}</small>
        </section>
      </main>
    );
  }
}
