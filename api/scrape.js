// api/scrape.js
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

// URL validation function
function isValidUrl(string) {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

// Google News specific user agents that work better
const googleNewsUserAgents = [
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/W.X.Y.Z‡ Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15'
];

function getRandomUserAgent() {
  return googleNewsUserAgents[Math.floor(Math.random() * googleNewsUserAgents.length)];
}

// Check if URL is Google News
function isGoogleNewsUrl(url) {
  return url.includes('news.google.com') || url.includes('google.com/url?');
}

// Extract actual article URL from Google News redirect
function extractActualUrl(googleUrl) {
  try {
    const urlObj = new URL(googleUrl);
    
    // For Google News article URLs like: https://news.google.com/articles/...
    if (urlObj.pathname.includes('/articles/')) {
      return googleUrl; // Keep as is, will be handled specially
    }
    
    // For Google redirect URLs like: https://www.google.com/url?url=...
    const actualUrl = urlObj.searchParams.get('url') || urlObj.searchParams.get('q');
    if (actualUrl) {
      return decodeURIComponent(actualUrl);
    }
    
    return googleUrl;
  } catch (error) {
    return googleUrl;
  }
}

// Get Google News RSS feed
async function getGoogleNewsRSS(query = 'india', lang = 'en', country = 'IN') {
  try {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${lang}&gl=${country}&ceid=${country}:${lang}`;
    
    const response = await axios.get(rssUrl, {
      timeout: 10000,
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'application/rss+xml, application/xml, text/xml'
      }
    });

    const $ = cheerio.load(response.data, { xmlMode: true });
    const articles = [];

    $('item').each((i, item) => {
      const $item = $(item);
      const title = $item.find('title').text().trim();
      const link = $item.find('link').text().trim();
      const description = $item.find('description').text().trim();
      const pubDate = $item.find('pubDate').text().trim();
      const source = $item.find('source').text().trim();

      if (title && link) {
        articles.push({
          title,
          link: extractActualUrl(link),
          description: description || null,
          published: pubDate || null,
          source: source || null
        });
      }
    });

    return articles;
  } catch (error) {
    throw new Error(`Failed to fetch Google News RSS: ${error.message}`);
  }
}

// Scrape article from original source
async function scrapeOriginalArticle(url) {
  const maxRetries = 2;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': getRandomUserAgent(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'DNT': '1',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1'
        },
        maxRedirects: 5
      });

      const $ = cheerio.load(response.data);
      
      // Remove unwanted elements
      $('script, style, nav, header, footer, .advertisement, .ads, .social-share, .related-articles').remove();

      // Extract title
      const title = $('h1').first().text().trim() || 
                   $('title').text().replace(/\s*\|\s*.*$/, '').trim() ||
                   $('[property="og:title"]').attr('content') ||
                   '';

      // Extract content using multiple selectors
      const contentSelectors = [
        'article p',
        '.article-content p',
        '.story-content p',
        '.content p',
        '.post-content p',
        '.entry-content p',
        'main p',
        '[data-module="ArticleBody"] p',
        '.article-body p'
      ];

      let content = '';
      for (const selector of contentSelectors) {
        const paragraphs = $(selector);
        if (paragraphs.length > 0) {
          paragraphs.each((i, p) => {
            const text = $(p).text().trim();
            if (text.length > 20) { // Only include substantial paragraphs
              content += text + '\n\n';
            }
          });
          if (content.length > 100) break; // Stop if we found good content
        }
      }

      // Extract images
      const images = [];
      $('img').each((i, img) => {
        const src = $(img).attr('src') || $(img).attr('data-src');
        if (src && !src.includes('logo') && !src.includes('icon') && src.length > 20) {
          try {
            const fullUrl = new URL(src, url).href;
            if (!images.includes(fullUrl)) {
              images.push(fullUrl);
            }
          } catch (e) {
            // Skip invalid URLs
          }
        }
      });

      // Extract timestamp
      let timestamp = null;
      const timeElement = $('time[datetime]').first();
      if (timeElement.length) {
        const datetime = timeElement.attr('datetime');
        if (datetime) {
          const date = new Date(datetime);
          if (!isNaN(date.getTime())) {
            timestamp = date.toISOString();
          }
        }
      }

      // Extract from meta tags if time element not found
      if (!timestamp) {
        const metaDate = $('meta[property="article:published_time"]').attr('content') ||
                        $('meta[name="publishdate"]').attr('content');
        if (metaDate) {
          const date = new Date(metaDate);
          if (!isNaN(date.getTime())) {
            timestamp = date.toISOString();
          }
        }
      }

      return {
        title: title || null,
        content: content.trim() || null,
        images: images.length > 0 ? images.slice(0, 5) : null, // Limit to 5 images
        timestamp,
        source_url: url
      };

    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  throw lastError;
}

// Main scraping function for Google News
async function scrapeGoogleNews(url, options = {}) {
  try {
    // If it's a Google News RSS request
    if (url === 'rss' || url.includes('rss')) {
      const articles = await getGoogleNewsRSS(options.query, options.lang, options.country);
      return {
        success: true,
        data: {
          type: 'rss_feed',
          articles: articles.slice(0, 10), // Limit to 10 articles
          total: articles.length,
          scraped_at: new Date().toISOString()
        }
      };
    }

    // Extract actual article URL if it's a Google News link
    const actualUrl = extractActualUrl(url);
    
    // If it's still a Google News article URL, we need to get the RSS and find it
    if (actualUrl.includes('news.google.com/articles/')) {
      return {
        success: false,
        error: 'Direct Google News article URLs are not accessible. Please use the RSS feed option or provide the original article URL.'
      };
    }

    // Scrape the actual article
    const articleData = await scrapeOriginalArticle(actualUrl);
    
    return {
      success: true,
      data: {
        type: 'article',
        url: actualUrl,
        original_google_url: url !== actualUrl ? url : null,
        ...articleData,
        scraped_at: new Date().toISOString()
      }
    };

  } catch (error) {
    throw new Error(`Google News scraping failed: ${error.message}`);
  }
}

// Main API route
app.get('/api/scrape', async (req, res) => {
  try {
    const { url, query = 'india', lang = 'en', country = 'IN', type = 'article' } = req.query;

    // Handle RSS feed requests
    if (type === 'rss' || url === 'rss') {
      const result = await scrapeGoogleNews('rss', { query, lang, country });
      return res.json(result);
    }

    // Validate URL parameter for article scraping
    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'URL parameter is required. Use type=rss for RSS feed or provide a Google News URL.'
      });
    }

    // Validate URL format
    if (!isValidUrl(url)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid URL format'
      });
    }

    // Scrape the article
    const result = await scrapeGoogleNews(url);
    res.json(result);

  } catch (error) {
    console.error('Scraping error:', error);
    
    let errorMessage = error.message || 'Internal server error';
    let statusCode = 500;
    
    if (error.response?.status === 403) {
      errorMessage = 'Access denied. The article source may be blocking requests.';
      statusCode = 403;
    } else if (error.response?.status === 404) {
      errorMessage = 'Article not found.';
      statusCode = 404;
    } else if (error.code === 'ENOTFOUND') {
      errorMessage = 'Unable to connect to the source website.';
      statusCode = 400;
    }

    res.status(statusCode).json({
      success: false,
      error: errorMessage,
      url: req.query.url || null
    });
  }
});

// Google News RSS endpoint
app.get('/api/news', async (req, res) => {
  try {
    const { query = 'india', lang = 'en', country = 'IN', limit = 10 } = req.query;
    
    const articles = await getGoogleNewsRSS(query, lang, country);
    
    res.json({
      success: true,
      data: {
        query,
        articles: articles.slice(0, parseInt(limit)),
        total: articles.length,
        scraped_at: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('RSS fetch error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    service: 'Google News Scraper',
    timestamp: new Date().toISOString() 
  });
});

// For local development
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Google News Scraper running on port ${PORT}`);
  });
}

module.exports = app;
