import { createContext, useContext, useReducer, type Dispatch, type ReactElement, type ReactNode } from 'react';
import { initialState, reducer, type Action, type AppState } from './appReducer';

const StateContext = createContext<AppState | undefined>(undefined);
const DispatchContext = createContext<Dispatch<Action> | undefined>(undefined);

/**
 * Value and dispatch are separate contexts so the many dispatch-only controls
 * in the inspector never re-render when unrelated state changes.
 */
export function AppStateProvider({ children }: { children: ReactNode }): ReactElement {
	const [state, dispatch] = useReducer(reducer, undefined, initialState);
	return (
		<StateContext.Provider value={state}>
			<DispatchContext.Provider value={dispatch}>{children}</DispatchContext.Provider>
		</StateContext.Provider>
	);
}

export function useAppState(): AppState {
	const s = useContext(StateContext);
	if (!s) {
		throw new Error('useAppState must be used inside AppStateProvider');
	}
	return s;
}

export function useDispatch(): Dispatch<Action> {
	const d = useContext(DispatchContext);
	if (!d) {
		throw new Error('useDispatch must be used inside AppStateProvider');
	}
	return d;
}
