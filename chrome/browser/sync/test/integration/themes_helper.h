// Copyright (c) 2011 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef CHROME_BROWSER_SYNC_TEST_INTEGRATION_THEMES_HELPER_H_
#define CHROME_BROWSER_SYNC_TEST_INTEGRATION_THEMES_HELPER_H_
#pragma once

#include <string>

#include "base/basictypes.h"
#include "base/compiler_specific.h"
#include "chrome/browser/sync/test/integration/sync_test.h"

class Profile;

namespace themes_helper {

// Gets the unique ID of the custom theme with the given index.
std::string GetCustomTheme(int index) WARN_UNUSED_RESULT;

// Gets the ID of |profile|'s theme.
std::string GetThemeID(Profile* profile) WARN_UNUSED_RESULT;

// Returns true iff |profile| is using a custom theme.
bool UsingCustomTheme(Profile* profile) WARN_UNUSED_RESULT;

// Returns true iff |profile| is using the default theme.
bool UsingDefaultTheme(Profile* profile) WARN_UNUSED_RESULT;

// Returns true iff |profile| is using the native theme.
bool UsingNativeTheme(Profile* profile) WARN_UNUSED_RESULT;

// Returns true iff a theme with the given ID is pending install in
// |profile|.
bool ThemeIsPendingInstall(
    Profile* profile, const std::string& id) WARN_UNUSED_RESULT;

// Returns true iff |profile|'s current theme is the given
// custom theme or if the given theme is pending install.
bool HasOrWillHaveCustomTheme(
    Profile* profile, const std::string& id) WARN_UNUSED_RESULT;

// Sets |profile| to use the custom theme with the given index.
void UseCustomTheme(Profile* profile, int index);

// Sets |profile| to use the default theme.
void UseDefaultTheme(Profile* profile);

// Sets |profile| to use the native theme.
void UseNativeTheme(Profile* profile);

}  // namespace themes_helper

#endif  // CHROME_BROWSER_SYNC_TEST_INTEGRATION_THEMES_HELPER_H_
