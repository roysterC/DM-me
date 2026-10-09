// Shapes shared by the API server and the web client.

export type Sender = 'user' | 'ai';
export type PhotoMode = 'keep' | 'once' | 'replay';
export type StoryBg = 'violet' | 'sunset' | 'ocean' | 'forest';

export interface UserDTO {
  id: number;
  username: string;
  isAdmin: boolean;
}

export interface PersonaDTO {
  id: string;
  name: string;
  handle: string;
  initial: string;
  bio: string;
}

export interface PhotoDTO {
  mode: PhotoMode;
  /** Present for kept photos only. View-once and replay photos are opened through `/open`. */
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

export interface OpenPhotoDTO {
  url: string;
  seconds: number;
  viewCount: number;
  maxViews: number;
}

export const STORY_BGS: StoryBg[] = ['violet', 'sunset', 'ocean', 'forest'];
