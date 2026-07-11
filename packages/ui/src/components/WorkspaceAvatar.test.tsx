// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { WorkspaceAvatar } from './WorkspaceAvatar';

describe('WorkspaceAvatar', () => {
    test('falls back to color-backed initials when an image cannot load', () => {
        const { container } = render(
            <WorkspaceAvatar
                name="Northwind Advisory"
                color="teal"
                avatarUrl="https://avatars.example.test/northwind.png"
                className="size-8 text-xs"
            />,
        );

        const image = container.querySelector('img');
        expect(image).not.toBeNull();
        fireEvent.error(image!);

        expect(container.querySelector('img')).toBeNull();
        expect(screen.getByText('NA')).toBeTruthy();
    });
});
