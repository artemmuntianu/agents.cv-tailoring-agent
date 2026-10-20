import { useDispatch, useSelector } from 'react-redux';
import type { RootState } from './store';
import type { AppDispatch } from './store';

export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();