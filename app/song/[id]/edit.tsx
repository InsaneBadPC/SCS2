import { useLocalSearchParams } from "expo-router";

import { SongEditor } from "@/components/song-editor";

export default function EditSongScreen() { const { id } = useLocalSearchParams<{ id: string }>(); return <SongEditor songId={id} />; }
