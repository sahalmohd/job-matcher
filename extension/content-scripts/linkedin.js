(() => {
  const SCAN_INTERVAL = 2000;
  const seenJobs = new Set();
  let lastUrl = '';

  function extractJobCards() {
    const jobs = [];

    const cards = document.querySelectorAll(
      [
        '.job-card-container',
        '.jobs-search-results__list-item',
        '.scaffold-layout__list-item',
        'li.jobs-search-results__list-item',
        'li[data-occludable-job-id]',
        '.job-card-list',
        'div.job-card-container--clickable',
      ].join(',')
    );

    for (const card of cards) {
      const titleEl =
        card.querySelector('a[href*="/jobs/view/"]') ||
        card.querySelector('.job-card-list__title') ||
        card.querySelector('.job-card-container__link') ||
        card.querySelector('a.job-card-list__title--link') ||
        card.querySelector('strong');

      const companyEl =
        card.querySelector('.job-card-container__primary-description') ||
        card.querySelector('.artdeco-entity-lockup__subtitle') ||
        card.querySelector('.job-card-container__company-name') ||
        card.querySelector('span.job-card-container__primary-description');

      const locationEl =
        card.querySelector('.job-card-container__metadata-item') ||
        card.querySelector('.artdeco-entity-lockup__caption') ||
        card.querySelector('.job-card-container__metadata-wrapper li');

      const title = titleEl?.textContent?.trim();
      const url = titleEl?.href || titleEl?.closest('a')?.href || card.querySelector('a')?.href;
      const company = companyEl?.textContent?.trim();
      const location = locationEl?.textContent?.trim();

      if (title && url && !seenJobs.has(url)) {
        seenJobs.add(url);
        jobs.push({ title, company, location, url, platform: 'linkedin' });
      }
    }

    return jobs;
  }

  function extractJobDetail() {
    // Try multiple selectors for the job description panel — LinkedIn changes these often
    const descEl =
      document.querySelector('.jobs-description__content') ||
      document.querySelector('.jobs-description-content__text') ||
      document.querySelector('.jobs-box__html-content') ||
      document.querySelector('#job-details') ||
      document.querySelector('[class*="jobs-description"]') ||
      document.querySelector('.jobs-unified-description__content') ||
      document.querySelector('article[class*="jobs"]');

    const titleEl =
      document.querySelector('.job-details-jobs-unified-top-card__job-title') ||
      document.querySelector('.jobs-unified-top-card__job-title') ||
      document.querySelector('h1[class*="job-title"]') ||
      document.querySelector('.t-24.job-details-jobs-unified-top-card__job-title') ||
      document.querySelector('h1 a[href*="/jobs/view/"]') ||
      document.querySelector('h2[class*="job-title"]');

    const companyEl =
      document.querySelector('.job-details-jobs-unified-top-card__company-name') ||
      document.querySelector('.jobs-unified-top-card__company-name') ||
      document.querySelector('span[class*="company-name"]') ||
      document.querySelector('a[href*="/company/"]');

    const locationEl =
      document.querySelector('.job-details-jobs-unified-top-card__bullet') ||
      document.querySelector('.jobs-unified-top-card__bullet') ||
      document.querySelector('span[class*="workplace-type"]') ||
      document.querySelector('.job-details-jobs-unified-top-card__primary-description-container span');

    if (!descEl) return null;

    const description = descEl.textContent?.trim() || '';
    if (description.length < 10) return null;

    // Build URL: prefer the canonical job URL from the page
    let jobUrl = window.location.href;
    const canonLink = document.querySelector('link[rel="canonical"]');
    if (canonLink?.href) jobUrl = canonLink.href;

    return {
      title: titleEl?.textContent?.trim() || '',
      company: companyEl?.textContent?.trim() || '',
      location: locationEl?.textContent?.trim() || '',
      description,
      url: jobUrl,
      platform: 'linkedin',
    };
  }

  function sendJobs(jobs) {
    if (jobs.length === 0) return;
    try {
      chrome.runtime.sendMessage({
        type: 'JOBS_FOUND',
        source: 'linkedin',
        jobs,
      });
    } catch {
      // Extension context invalidated (e.g. after reload)
    }
  }

  function scan() {
    const cards = extractJobCards();
    const detail = extractJobDetail();
    const jobs = [];

    if (detail && detail.description) {
      const key = detail.url || detail.title;
      if (!seenJobs.has('detail:' + key)) {
        seenJobs.add('detail:' + key);
        jobs.push(detail);
      }
    }

    for (const card of cards) {
      jobs.push(card);
    }

    sendJobs(jobs);
  }

  // Detect when the detail panel content changes (user clicked a new job)
  function watchDetailPanel() {
    const observer = new MutationObserver(() => {
      // Debounce: only extract after DOM settles
      clearTimeout(watchDetailPanel._timer);
      watchDetailPanel._timer = setTimeout(() => {
        const detail = extractJobDetail();
        if (detail && detail.description) {
          const key = detail.url || detail.title;
          if (!seenJobs.has('enriched:' + key)) {
            seenJobs.add('enriched:' + key);
            sendJobs([detail]);
          }
        }
      }, 500);
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Detect SPA navigation (LinkedIn doesn't do full page reloads)
  function watchNavigation() {
    setInterval(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        // Reset detail tracking for new page context
        setTimeout(scan, 1000);
      }
    }, 1000);
  }

  watchDetailPanel();
  watchNavigation();
  setInterval(scan, SCAN_INTERVAL);

  // Initial scan with a small delay to let the page finish rendering
  setTimeout(scan, 1500);
})();
