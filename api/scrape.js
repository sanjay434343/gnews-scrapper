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

// User agents for scraping
const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
];

function getRandomUserAgent() {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
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

    const article = await scrapeArticle(url);
    res.json({
      success: true,
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
    service: 'Article Scraper API',
    timestamp: new Date().toISOString() 
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Article Scraper API running on port ${PORT}`);
});
