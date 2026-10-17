import { google } from "googleapis";

// Unlike the sibling projects' publishPost (which take a single `label`
// string), this one takes `labels` (a string array) — each post here gets
// several labels at once: artist/band name(s), genre, origin, and a
// first-letter index label. Blogger's API natively accepts an array for the
// `labels` field, so this is passed straight through, deduplicated.
export async function publishPost(auth, { blogId, title, contentHtml, labels, isDraft = false }) {
  const blogger = google.blogger({ version: "v3", auth });
  const uniqueLabels = [...new Set((labels || []).map((l) => l.trim()).filter(Boolean))];
  const { data } = await blogger.posts.insert({
    blogId,
    isDraft,
    requestBody: {
      title,
      content: contentHtml,
      labels: uniqueLabels,
    },
  });
  return { url: data.url, id: data.id };
}

export async function detectBlogId(auth, blogUrl) {
  const blogger = google.blogger({ version: "v3", auth });
  const { data } = await blogger.blogs.getByUrl({ url: blogUrl });
  return data.id;
}
