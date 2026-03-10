(() => {
  const SCAN_INTERVAL = 3000;
  const seenJobs = new Set();

  function extractJobCards() {
    const jobs = [];

    // LinkedIn job listing cards in search results
    const cards = document.querySelectorAll('.job-card-container, .jobs-search-results__list-item, .scaffold-layout__list-item');
    for (const card of cards) {
      const titleEl = card.querySelector('.job-card-list__title, .job-card-container__link, a.job-card-list__title--link');
      const companyEl = card.querySelector('.job-card-container__primary-description, .artdeco-entity-lockup__subtitle');
      const locationEl = card.querySelector('.job-card-container__metadata-item, .artdeco-entity-lockup__caption');

      const title = titleEl?.textContent?.trim();
      const url = titleEl?.href || titleEl?.closest('a')?.href;
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
    // Full job description from the detail panel
    const descEl = document.querySelector(
      '.jobs-description__content, .jobs-box__html-content, .jobs-description-content__text'
    );
    const titleEl = document.querySelector('.job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card__job-title');
    const companyEl = document.querySelector('.job-details-jobs-unified-top-card__company-name, .jobs-unified-top-card__company-name');
    const locationEl = document.querySelector('.job-details-jobs-unified-top-card__bullet, .jobs-unified-top-card__bullet');

    if (!descEl) return null;

    return {
      title: titleEl?.textContent?.trim() || '',
      company: companyEl?.textContent?.trim() || '',
      location: locationEl?.textContent?.trim() || '',
      description: descEl?.textContent?.trim() || '',
      url: window.location.href,
      platform: 'linkedin',
    };
  }

  function scan() {
    const cards = extractJobCards();
    const detail = extractJobDetail();

    const payload = { type: 'JOBS_FOUND', source: 'linkedin', jobs: [] };

    if (detail && detail.description) {
      const key = detail.url || detail.title;
      if (!seenJobs.has('detail:' + key)) {
        seenJobs.add('detail:' + key);
        payload.jobs.push(detail);
      }
    }

    for (const card of cards) {
      payload.jobs.push(card);
    }

    if (payload.jobs.length > 0) {
      chrome.runtime.sendMessage(payload);
    }
  }

  // Enrich job cards that lack descriptions by clicking through
  // (only the currently visible detail panel)
  function enrichCards() {
    const detail = extractJobDetail();
    if (detail && detail.description) {
      const existing = seenJobs.has('enriched:' + detail.url);
      if (!existing) {
        seenJobs.add('enriched:' + detail.url);
        chrome.runtime.sendMessage({
          type: 'JOBS_FOUND',
          source: 'linkedin',
          jobs: [detail],
        });
      }
    }
  }

  // Observe DOM mutations for SPA navigation
  const observer = new MutationObserver(() => {
    enrichCards();
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Periodic scan for new cards
  setInterval(scan, SCAN_INTERVAL);
  scan();
})();
