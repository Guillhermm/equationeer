export type ExplanationDepth = "grad" | "undergrad" | "curious";

export interface ExplainMathRequest {
  type: "EXPLAIN_MATH";
  payload: {
    math: string;
    surroundingText: string;
    pageTitle: string;
    pageUrl: string;
    depth: ExplanationDepth;
  };
}

export interface ExplainImageRequest {
  type: "EXPLAIN_IMAGE";
  payload: {
    imageDataUrl: string;
    pageTitle: string;
    pageUrl: string;
    depth: ExplanationDepth;
  };
}

export interface FollowUpRequest {
  type: "FOLLOW_UP";
  payload: {
    question: string;
    conversationHistory: ConversationMessage[];
    originalMath: string;
    depth: ExplanationDepth;
  };
}

export interface ValidateKeyRequest {
  type: "VALIDATE_API_KEY";
  payload: { apiKey: string };
}

export interface OpenSidePanelRequest {
  type: "OPEN_SIDE_PANEL";
}

export interface GetSettingsRequest {
  type: "GET_SETTINGS";
}

export interface SaveSettingsRequest {
  type: "SAVE_SETTINGS";
  payload: Partial<AppSettings>;
}

export type ExtensionMessage =
  | ExplainMathRequest
  | ExplainImageRequest
  | FollowUpRequest
  | ValidateKeyRequest
  | OpenSidePanelRequest
  | GetSettingsRequest
  | SaveSettingsRequest;

export interface StreamChunk {
  type: "STREAM_CHUNK";
  text: string;
}

export interface StreamDone {
  type: "STREAM_DONE";
  fullText: string;
}

export interface StreamError {
  type: "STREAM_ERROR";
  error: string;
}

export type StreamMessage = StreamChunk | StreamDone | StreamError;

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AppSettings {
  apiKey: string;
  defaultDepth: ExplanationDepth;
  theme: "dark" | "light" | "system";
  onboardingCompleted: boolean;
}

export interface HistoryEntry {
  id: string;
  math: string;
  explanation: string;
  depth: ExplanationDepth;
  pageTitle: string;
  pageUrl: string;
  timestamp: number;
  bookmarked: boolean;
  conversation: ConversationMessage[];
  isImage: boolean;
}
