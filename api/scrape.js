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

// Extract actual article URL from Google News redirect
function extractRealArticleUrl(googleUrl) {
  try {
    // Google News RSS links are encoded - we need to decode them
    if (googleUrl.includes('news.google.com/rss/articles/')) {
      // These are Google News internal URLs, we'll need to resolve them
      return googleUrl;
    }
    
    const urlObj = new URL(googleUrl);
    const actualUrl = urlObj.searchParams.get('url') || urlObj.searchParams.get('q');
    if (actualUrl) {
      return decodeURIComponent(actualUrl);
    }
    
    return googleUrl;
  } catch (error) {
    return googleUrl;
  }
}

// Resolve Google News URL to actual article URL
async function resolveGoogleNewsUrl(googleUrl) {
  try {
    const response = await axios.get(googleUrl, {
      timeout: 10000,
      maxRedirects: 0, // Don't follow redirects automatically
      validateStatus: status => status >= 200 && status < 400
    });
    
    // Check for redirect in response
    const location = response.headers.location;
    if (location) {
      return location;
    }
    
    return googleUrl;
  } catch (error) {
    if (error.response && error.response.headers.location) {
      return error.response.headers.location;
    }
    return googleUrl;
  }
}

// Get Google News RSS feed with full content
async function getGoogleNewsRSS(query = 'india', lang = 'en', country = 'IN', includeContent = true) {
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

    // Process each RSS item
    const items = $('item').slice(0, 10); // Limit to 10 articles for performance
    
    for (let i = 0; i < items.length; i++) {
      const item = items.eq(i);
      const title = item.find('title').text().trim();
      const link = item.find('link').text().trim();
      const description = item.find('description').text().trim();
      const pubDate = item.find('pubDate').text().trim();
      const source = item.find('source').text().trim();

      if (title && link) {
        let articleData = {
          title,
          original_link: link,
          description: description ? description.replace(/<[^>]*>/g, '').trim() : null,
          published: pubDate || null,
          source: source || null,
          content: null,
          images: null,
          resolved_url: null
        };

        // If includeContent is true, fetch the full article content
        if (includeContent) {
          try {
            console.log(`Fetching content for article ${i + 1}: ${title.substring(0, 50)}...`);
            
            // Try to resolve the Google News URL to actual article URL
            let actualUrl = await resolveGoogleNewsUrl(link);
            
            // If still a Google News URL, try to extract from the link structure
            if (actualUrl.includes('news.google.com')) {
              // Skip Google News internal URLs for now
              console.log('Skipping Google News internal URL');
              articleData.error = 'Google News internal URL - cannot resolve to original source';
            } else {
              articleData.resolved_url = actualUrl;
              
              // Fetch the actual article content
              const contentData = await scrapeOriginalArticle(actualUrl);
              articleData.content = contentData.content;
              articleData.images = contentData.images;
              articleData.timestamp = contentData.timestamp;
              
              // Add a small delay to avoid overwhelming servers
              await new Promise(resolve => setTimeout(resolve, 500));
            }
          } catch (error) {
            console.log(`Failed to fetch content for article: ${error.message}`);
            articleData.error = `Failed to fetch content: ${error.message}`;
          }
        }

        articles.push(articleData);
      }
    }

    return articles;
  } catch (error) {
    throw new Error(`Failed to fetch Google News RSS: ${error.message}`);
  }
}

// Enhanced article scraping with better selectors
async function scrapeOriginalArticle(url) {
  const maxRetries = 2;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.get(url, {
        timeout: 20000,
        headers: {
          'User-Agent': getRandomUserAgent(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'DNT': '1',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        },
        maxRedirects: 5
      });

      const $ = cheerio.load(response.data);
      const hostname = new URL(url).hostname;
      
      // Remove unwanted elements
      $('script, style, nav, header, footer, .advertisement, .ads, .social-share, .related-articles, .comments, iframe, .video-player').remove();

      // Extract title with priority order
      let title = '';
      const titleSelectors = [
        'h1[class*="headline"]',
        'h1[class*="title"]',
        'h1[class*="story"]',
        '[property="og:title"]',
        'h1',
        'title'
      ];

      for (const selector of titleSelectors) {
        if (selector === '[property="og:title"]') {
          title = $(selector).attr('content');
        } else if (selector === 'title') {
          title = $(selector).text().replace(/\s*\|\s*.*$/, '').trim();
        } else {
          title = $(selector).first().text().trim();
        }
        if (title && title.length > 10) break;
      }

      // Extract content with comprehensive selectors
      const contentSelectors = [
        '[data-module="ArticleBody"]',
        '.article-content',
        '.story-content',
        '.content',
        '.post-content',
        '.entry-content',
        '.article-body',
        '.story-body',
        'main article',
        'article',
        '.news-content',
        '.article-text',
        '.story-text'
      ];

      let content = '';
      let foundContent = false;

      for (const selector of contentSelectors) {
        const contentDiv = $(selector).first();
        if (contentDiv.length > 0) {
          // Find all paragraph tags within this content area
          const paragraphs = contentDiv.find('p, div.paragraph, .story-element-text');
          
          if (paragraphs.length > 0) {
            paragraphs.each((i, p) => {
              const text = $(p).text().trim();
              if (text.length > 30 && !text.toLowerCase().includes('advertisement')) {
                content += text + '\n\n';
              }
            });
            
            if (content.length > 200) {
              foundContent = true;
              break;
            }
          }
        }
      }

      // Fallback: try to get any substantial paragraphs
      if (!foundContent) {
        $('p').each((i, p) => {
          const text = $(p).text().trim();
          if (text.length > 50 && !text.toLowerCase().includes('advertisement') && !text.toLowerCase().includes('subscribe')) {
            content += text + '\n\n';
          }
        });
      }

      // Extract images with better filtering
      const images = [];
      const imgSelectors = [
        'img[class*="article"]',
        'img[class*="story"]',
        'img[class*="content"]',
        'img[class*="featured"]',
        'figure img',
        '.image-container img',
        'img'
      ];

      imgSelectors.forEach(selector => {
        $(selector).each((i, img) => {
          const src = $(img).attr('src') || $(img).attr('data-src') || $(img).attr('data-lazy-src');
          const alt = $(img).attr('alt') || '';
          
          if (src && 
              !src.includes('logo') && 
              !src.includes('icon') && 
              !src.includes('avatar') &&
              !src.includes('placeholder') &&
              !alt.toLowerCase().includes('logo') &&
              src.length > 20) {
            try {
              const fullUrl = new URL(src, url).href;
              if (!images.includes(fullUrl) && images.length < 10) {
                images.push(fullUrl);
              }
            } catch (e) {
              // Skip invalid URLs
            }
          }
        });
      });

      // Extract timestamp with multiple methods
      let timestamp = null;
      const timeSelectors = [
        'time[datetime]',
        '[property="article:published_time"]',
        '[name="publishdate"]',
        '[name="date"]',
        '.published-date',
        '.article-date',
        '.story-date',
        '.timestamp'
      ];

      for (const selector of timeSelectors) {
        const element = $(selector).first();
        if (element.length) {
          let dateStr = '';
          if (selector.startsWith('[')) {
            dateStr = element.attr('content') || element.attr('datetime');
          } else {
            dateStr = element.attr('datetime') || element.text().trim();
          }
          
          if (dateStr) {
            const date = new Date(dateStr);
            if (!isNaN(date.getTime())) {
              timestamp = date.toISOString();
              break;
            }
          }
        }
      }

      // Validate that we got meaningful content
      if (!title && content.length < 100) {
        throw new Error('Insufficient content extracted - possible blocking or paywall');
      }

      return {
        title: title || null,
        content: content.trim() || null,
        images: images.length > 0 ? images : null,
        timestamp,
        source_url: url,
        word_count: content.split(' ').length
      };

    } catch (error) {
      lastError = error;
      console.log(`Article scraping attempt ${attempt} failed for ${url}: ${error.message}`);
      
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 2000));
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
      const includeContent = options.includeContent !== false; // Default to true
      const articles = await getGoogleNewsRSS(options.query, options.lang, options.country, includeContent);
      return {
        success: true,
        data: {
          type: 'rss_feed_with_content',
          query: options.query || 'india',
          articles: articles,
          total: articles.length,
          scraped_at: new Date().toISOString()
        }
      };
    }

    // Extract actual article URL if it's a Google News link
    const actualUrl = extractRealArticleUrl(url);
    
    // If it's still a Google News article URL, try to resolve it
    if (actualUrl.includes('news.google.com/articles/')) {
      const resolvedUrl = await resolveGoogleNewsUrl(actualUrl);
      if (resolvedUrl !== actualUrl) {
        const articleData = await scrapeOriginalArticle(resolvedUrl);
        return {
          success: true,
          data: {
            type: 'article',
            url: resolvedUrl,
            original_google_url: url,
            ...articleData,
            scraped_at: new Date().toISOString()
          }
        };
      } else {
        return {
          success: false,
          error: 'Unable to resolve Google News URL to original article source'
        };
      }
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
    const { 
      url, 
      query = 'india', 
      lang = 'en', 
      country = 'IN', 
      type = 'article',
      include_content = 'true',
      limit = '5'
    } = req.query;

    // Handle RSS feed requests with full content
    if (type === 'rss' || url === 'rss') {
      const includeContent = include_content.toLowerCase() !== 'false';
      const result = await scrapeGoogleNews('rss', { 
        query, 
        lang, 
        country, 
        includeContent,
        limit: parseInt(limit) 
      });
      return res.json(result);
    }

    // Validate URL parameter for article scraping
    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'URL parameter is required. Use type=rss for RSS feed with full content, or provide a news article URL.',
        examples: {
          rss_with_content: '/api/scrape?type=rss&query=technology&include_content=true',
          rss_links_only: '/api/scrape?type=rss&query=sports&include_content=false',
          single_article: '/api/scrape?url=ARTICLE_URL'
        }
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
    } else if (error.message.includes('timeout')) {
      errorMessage = 'Request timeout. The operation took too long.';
      statusCode = 408;
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
