<?php
namespace App\Http;

use App\Models\User;
require_once __DIR__ . "/helpers.php";

class UserController {
    public function show() { return new User(); }
}
