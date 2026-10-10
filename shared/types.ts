// Shapes shared by the API server and the web client.

export type Sender = 'user' | 'ai';
export type PhotoMode = 'keep' | 'once' | 'replay';
/** How Alisa sends a camera-roll photo: her choice each time, or always one way. */
export type SendMode = 'auto' | PhotoMode;
export type StoryBg = 'violet' | 'sunset' | 'ocean' | 'forest';

export interface PersonaDTO {
  id: string;
  name: string;
  handle: string;
  initial: string;
  bio: string;
}

export interface PhotoDTO {
  mode: PhotoMode;
  /** Kept photos only, and null when the file is gone. View-once and replay photos are opened through `/open`. */
  url: string | null;
  width: number | null;
  height: number | null;
  viewCount: number;
  /** 1 for view once, 2 for allow replay, null for kept photos. */
  maxViews: number | null;
}

export interface StoryRefDTO {
  id: number;
  kind: 'photo' | 'text';
  caption: string | null;
  bg: StoryBg | null;
  /** Null once the story has expired or been deleted. */
  thumbUrl: string | null;
  available: boolean;
}

export interface MessageDTO {
  id: number;
  sender: Sender;
  kind: 'text' | 'photo' | 'story_reply';
  text: string | null;
  createdAt: string;
  readAt: string | null;
  heartByUser: boolean;
  heartByAi: boolean;
  photo: PhotoDTO | null;
  story: StoryRefDTO | null;
}

export interface ChatDTO {
  persona: PersonaDTO;
  messages: MessageDTO[];
  /** False when the server has no way to reach Claude, so the UI can say so up front. */
  aiConnected: boolean;
}

export interface StoryDTO {
  id: number;
  kind: 'photo' | 'text';
  caption: string | null;
  bg: StoryBg | null;
  mediaUrl: string | null;
  createdAt: string;
  expiresAt: string;
  seen: boolean;
  liked: boolean;
}

export interface AdminStoryDTO extends StoryDTO {
  active: boolean;
  views: number;
}

/** A photo in Alisa's camera roll: she picks from these when she sends a photo. */
export interface LibraryPhotoDTO {
  id: number;
  url: string;
  width: number | null;
  height: number | null;
  description: string;
  /** One of the bundled sample photos rather than an upload. */
  sample: boolean;
  sendMode: SendMode;
  createdAt: string;
}

export interface OpenPhotoDTO {
  url: string;
  seconds: number;
  viewCount: number;
  maxViews: number;
}

export const STORY_BGS: StoryBg[] = ['violet', 'sunset', 'ocean', 'forest'];
