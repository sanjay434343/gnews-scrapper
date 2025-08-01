// index.js
import express from 'express';
import axios from 'axios';
import cheerio from 'cheerio';

const app = express();
const PORT = process.env.PORT || 3000;

const extractFullArticle = async (url) => {
  try {
    const { data } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    });
    const $ = cheerio.load(data);
    const paragraphs = $('article p').map((i, el) => $(el).text()).get();
    const images = $('article img').map((i, el) => $(el).attr('src')).get();

    const content = paragraphs.join('\n').trim();
    const image = images.find(img => img?.startsWith('http')) || null;

    return { content, image };
  } catch (err) {
    console.error("Failed to extract article:", err.message);
    return { content: '', image: null };
  }
};

const extractGoogleNews = async (query) => {
  const url = `https://news.google.com/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;

  try {
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const $ = cheerio.load(data);
    const articles = [];

    $('article').each((_, el) => {
      const anchor = $(el).find('h3 a').attr('href');
      const fullLink = anchor?.startsWith('/articles/') ? `https://news.google.com${anchor}` : null;
      const title = $(el).find('h3').text().trim();
      const source = $(el).find('div span').first().text().trim();
      const time = $(el).find('time').attr('datetime');

      if (title && fullLink) {
        articles.push({ title, source, time, gnews_url: fullLink });
      }
    });

    return articles;
  } catch (err) {
    console.error("Error fetching Google News:", err.message);
    return [];
  }
};

const resolveGoogleRedirect = async (gnews_url) => {
  try {
    const { data } = await axios.get(gnews_url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const $ = cheerio.load(data);
    const realUrl = $('meta[http-equiv="refresh"]').attr('content')?.split('url=')[1];
    return realUrl || gnews_url;
  } catch {
    return gnews_url;
  }
};

app.get('/api/news', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query param ?q=' });

  const basicResults = await extractGoogleNews(q);
  const resultsWithContent = await Promise.all(
    basicResults.slice(0, 5).map(async (article) => {
      const resolvedUrl = await resolveGoogleRedirect(article.gnews_url);
      const { content, image } = await extractFullArticle(resolvedUrl);
      return { ...article, resolvedUrl, content, image };
    })
  );

  res.json(resultsWithContent);
});

app.listen(PORT, () => {
  console.log(`📰 Google News API running at http://localhost:${PORT}`);
});
