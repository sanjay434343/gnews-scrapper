const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');
const app = express();

// Middleware
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// URL validation
function isValidUrl(string) {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

// User agents for Google News
const userAgents = [
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15'
];

function getRandomUserAgent() {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

// Enhanced URL resolver for Google News
async function resolveGoogleNewsUrl(googleUrl) {
  try {
    const response = await axios.get(googleUrl, {
      timeout: 10000,
      maxRedirects: 0,
      headers: { 'User-Agent': getRandomUserAgent() },
      validateStatus: status => status >= 200 && status < 400
    });

    // Handle HTTP redirects
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      return new URL(response.headers.location, googleUrl).href;
    }

    // Parse HTML for redirects
    const $ = cheerio.load(response.data);
    
    // Check meta refresh redirect
    const metaRefresh = $('meta[http-equiv="refresh"]').attr('content');
    if (metaRefresh) {
      const urlMatch = metaRefresh.match(/url=(.*)$/i);
      if (urlMatch && urlMatch[1]) {
        return new URL(urlMatch[1], googleUrl).href;
      }
    }

    // Check JavaScript redirects
    const scriptRedirect = $('script').text().match(/window\.location\.(?:href|replace)\s*=\s*['"]([^'"]+)['"]/i);
    if (scriptRedirect && scriptRedirect[1]) {
      return new URL(scriptRedirect[1], googleUrl).href;
    }

    return googleUrl;
  } catch (error) {
    if (error.response?.headers?.location) {
      return new URL(error.response.headers.location, googleUrl).href;
    }
    return googleUrl;
  }
}

// Main scraping function
async function scrapeArticle(url) {
  try {
    const response = await axios.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': getRandomUserAgent() }
    });

    const $ = cheerio.load(response.data);
    const hostname = new URL(url).hostname;

    // Remove unwanted elements
    $('script, style, nav, header, footer, .ad, .ads, .social, .related, .comments, iframe').remove();

    // Extract title
    const titleSelectors = [
      'h1[class*="headline"]',
      'h1[class*="title"]',
      'h1[class*="story"]',
      '[property="og:title"]',
      'title'
    ];
    
    let title = '';
    for (const selector of titleSelectors) {
      if (selector === '[property="og:title"]') {
        title = $(selector).attr('content') || '';
      } else if (selector === 'title') {
        title = $(selector).text().replace(/\s*\|\s*.*$/, '').trim();
      } else {
        title = $(selector).first().text().trim();
      }
      if (title && title.length > 10) break;
    }

    // Extract content
    const contentSelectors = [
      'article',
      '.article-content',
      '.story-content',
      '.post-content',
      '.entry-content',
      '.article-body',
      'main'
    ];
    
    let content = '';
    for (const selector of contentSelectors) {
      const contentElement = $(selector).first();
      if (contentElement.length) {
        contentElement.find('p').each((i, el) => {
          const text = $(el).text().trim();
          if (text.length > 30 && !text.toLowerCase().includes('advertisement')) {
            content += text + '\n\n';
          }
        });
        if (content.length > 200) break;
      }
    }

    // Fallback if no content found
    if (!content) {
      $('p').each((i, el) => {
        const text = $(el).text().trim();
        if (text.length > 50 && !text.toLowerCase().includes('advertisement')) {
          content += text + '\n\n';
        }
      });
    }

    // Extract images
    const images = [];
    $('img').each((i, img) => {
      const src = $(img).attr('src') || $(img).attr('data-src');
      if (src && src.length > 20 && 
          !src.includes('logo') && 
          !src.includes('icon') && 
          images.length < 5) {
        try {
          images.push(new URL(src, url).href);
        } catch (e) {
          // Skip invalid URLs
        }
      }
    });

    // Extract metadata
    let published = null;
    const dateSelectors = [
      'time[datetime]',
      '[property="article:published_time"]',
      '.published-date',
      '.article-date'
    ];
    
    for (const selector of dateSelectors) {
      const element = $(selector).first();
      if (element.length) {
        const dateStr = element.attr('datetime') || element.attr('content') || element.text().trim();
        if (dateStr) {
          const date = new Date(dateStr);
          if (!isNaN(date.getTime())) published = date.toISOString();
          if (published) break;
        }
      }
    }

    return {
      title: title || 'No title found',
      content: content.trim() || 'No content available',
      images,
      published,
      source: hostname,
      url,
      word_count: content.split(/\s+/).length
    };
  } catch (error) {
    console.error(`Scraping failed for ${url}: ${error.message}`);
    return {
      error: `Scraping failed: ${error.message}`,
      url
    };
  }
}

// Google News RSS parser
async function getGoogleNewsRSS(query = 'technology', lang = 'en', country = 'US') {
  try {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${lang}&gl=${country}`;
    const response = await axios.get(rssUrl, {
      timeout: 10000,
      headers: { 'User-Agent': getRandomUserAgent() }
    });

    const $ = cheerio.load(response.data, { xmlMode: true });
    const articles = [];

    $('item').each((i, el) => {
      const title = $(el).find('title').text().trim();
      const link = $(el).find('link').text().trim();
      const description = $(el).find('description').text().trim();
      const pubDate = $(el).find('pubDate').text().trim();
      const source = $(el).find('source').text().trim();

      if (title && link) {
        articles.push({
          title,
          original_link: link,
          description: description.replace(/<[^>]*>/g, '').trim(),
          published: pubDate,
          source: source || 'Unknown source'
        });
      }
    });

    return articles.slice(0, 10);
  } catch (error) {
    throw new Error(`RSS fetch failed: ${error.message}`);
  }
}

// Main API endpoint
app.get('/api/news', async (req, res) => {
  try {
    const { 
      query = 'technology', 
      lang = 'en', 
      country = 'US',
      full_content = 'false'
    } = req.query;

    // Get RSS feed
    const articles = await getGoogleNewsRSS(query, lang, country);
    
    // Resolve URLs and get full content if requested
    if (full_content.toLowerCase() === 'true') {
      for (const article of articles) {
        try {
          // Resolve Google News URL
          let resolvedUrl = await resolveGoogleNewsUrl(article.original_link);
          
          // If still Google News URL, try parameter extraction
          if (resolvedUrl.includes('news.google.com')) {
            const urlParams = new URL(resolvedUrl).searchParams;
            resolvedUrl = urlParams.get('url') || resolvedUrl;
          }
          
          // Scrape actual article
          const content = await scrapeArticle(resolvedUrl);
          article.content = content.content;
          article.images = content.images;
          article.resolved_url = resolvedUrl;
          
          // Add delay between requests
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          article.error = `Content fetch failed: ${error.message}`;
        }
      }
    }

    res.json({
      success: true,
      query,
      articles,
      count: articles.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Single article endpoint
app.get('/api/article', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url || !isValidUrl(url)) {
      return res.status(400).json({
        success: false,
        error: 'Valid URL parameter is required'
      });
    }

    // Resolve Google News URLs
    let targetUrl = url;
    if (url.includes('news.google.com')) {
      targetUrl = await resolveGoogleNewsUrl(url);
      
      // If still Google News URL, try parameter extraction
      if (targetUrl.includes('news.google.com')) {
        const urlParams = new URL(targetUrl).searchParams;
        targetUrl = urlParams.get('url') || targetUrl;
      }
    }

    const article = await scrapeArticle(targetUrl);
    res.json({
      success: true,
      original_url: url,
      resolved_url: targetUrl,
      ...article
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    service: 'News Scraper API',
    timestamp: new Date().toISOString() 
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`News Scraper API running on port ${PORT}`);
});
