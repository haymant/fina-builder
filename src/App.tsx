import { ThemeProvider } from './features/themes/ThemeProvider'
import { Workspace } from './features/workspace/components/Workspace'

export default function App() {
  return <ThemeProvider><Workspace /></ThemeProvider>
}
