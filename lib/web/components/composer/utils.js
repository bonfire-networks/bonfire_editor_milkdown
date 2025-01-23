import { gemoji } from "gemoji";

export const transformMarkdown = (markdown) => {
    if (!markdown) return "";
    
    return markdown
      .replace(/!\[(.*?)\]\(.*?\)/g, "$1")
      .replace(/(^|\s)\\#/g, "$1#")
      .replace(/(#[^_\s]+)\\(_[^_\s]+)/g, "$1$2");
  };
  
  export const getFeedItems = async (queryText, prefix) => {
    if (!queryText?.length) return [];
  
    try {
      const response = await fetch(`/api/tag/autocomplete/ck5/${prefix}/${queryText}`);
      if (!response.ok) throw new Error('Network response was not ok');
      
      const data = await response.json();
      return data.map(item => ({
        id: item.id,
        value: item.name,
        icon: item.icon
      }));
    } catch (error) {
      console.error("Error fetching tag suggestions:", error);
      return [];
    }
  };