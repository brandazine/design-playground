import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    diff: 'MVP scaffold: git diff integration pending.'
  });
}
