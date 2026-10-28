export const DEFAULT_ARTIST_ALBUM_KEYWORDS = "remix";

export interface ArtistAlbumFilters {
  artistAlbumHideSingles?: boolean;
  artistAlbumHideRemixes?: boolean;
  artistAlbumTrackLimit?: number;
  artistAlbumKeywords?: string;
}

export function normalizeArtistAlbumFilters(filters: ArtistAlbumFilters) {
  return {
    artistAlbumHideSingles: !!filters.artistAlbumHideSingles,
    artistAlbumHideRemixes: !!filters.artistAlbumHideRemixes,
    artistAlbumTrackLimit: Number.isSafeInteger(filters.artistAlbumTrackLimit) && filters.artistAlbumTrackLimit! >= 0 ? filters.artistAlbumTrackLimit! : 1,
    artistAlbumKeywords: typeof filters.artistAlbumKeywords === "string" ? filters.artistAlbumKeywords : DEFAULT_ARTIST_ALBUM_KEYWORDS,
  };
}

export const artistAlbumKeywords = (value: string): string[] => [...new Set(value.split(/[;；]/).map(word => word.trim().toLowerCase()).filter(Boolean))];
export const artistAlbumFilterKey = (filters: ArtistAlbumFilters): string => {
  const value = normalizeArtistAlbumFilters(filters);
  return JSON.stringify([value.artistAlbumHideSingles, value.artistAlbumHideRemixes, value.artistAlbumTrackLimit, artistAlbumKeywords(value.artistAlbumKeywords)]);
};
